"use strict";

import Bitstring from "./bitstring.mjs";
import ERTS from "./erts.mjs";
import HologramInterpreterError from "./errors/interpreter_error.mjs";
import Interpreter from "./interpreter.mjs";
import MapData from "./map_data.mjs";
import Serializer from "./serializer.mjs";

// #878: TrieMap._order is a prepend-only chain of {key, next} nodes - see
// TrieMap's own doc comment for why. head is the most recently inserted key,
// so walking head->tail and collecting visits keys newest-first; reversing
// that once at the end restores true (oldest-first) insertion order. O(n),
// same as the array version - this is the cold path (.data/mapEntries),
// not the hot put/merge path the chain shape exists to keep O(1)/O(size(map2)).
function materializeOrder(node) {
  const keys = [];

  while (node !== null) {
    keys.push(node.key);
    node = node.next;
  }

  keys.reverse();

  return keys;
}

// #878 (structural sharing): a proper-list cons cell built by Type.cons().
// Kept as its own class (rather than a plain object literal like every
// other boxed term) specifically so `data` can be a *prototype* getter -
// one property definition per materialized list, not one per cons, which is
// what keeps consing off the packed-list array-copy path without churning
// V8 hidden classes on every single cons. Improper-list construction never
// reaches this class - see Type.cons().
class ConsCell {
  // True private field, not a shadowing own-property trick: caching the
  // materialized array here means repeated .data reads on the same
  // instance are O(1) after the first, exactly like the old approach, but
  // `data` itself stays a *prototype* getter forever - never becomes an
  // own property. That matters beyond micro-optimization: chai/Node's
  // deepStrictEqual only ever compares own enumerable properties, so it
  // never invokes a prototype getter at all. Shadowing `data` as an own
  // property (the previous approach) made two logically-identical lists
  // compare *unequal* under deepStrictEqual purely because one of them had
  // incidentally had .data read somewhere (inspect, serialization, error
  // formatting, ...) before the comparison ran and the other hadn't -
  // caching state leaking into a correctness-sensitive equality check.
  #data;

  constructor(head, tail) {
    this.type = "list";
    this.isProper = true;
    this.isConsCell = true;
    this.head = head;
    this.tail = tail;
  }

  get data() {
    if (this.#data !== undefined) {
      return this.#data;
    }

    const items = [];
    let node = this;

    while (node instanceof ConsCell) {
      items.push(node.head);
      node = node.tail;
    }

    // A cons chain always bottoms out in a packed proper list - see
    // Type.cons(): a cons cell is only ever built when its tail is already
    // a proper list, so `node` here is guaranteed proper-packed, never a
    // ConsCell (loop wouldn't have exited) and never an improper list.
    items.push(...node.data);

    this.#data = items;

    return items;
  }
}

// #878: a boxed map backed by map_data.mjs's persistent HAMT. `_trie` and
// `_size` are this class's own private-by-convention fields - never read
// outside this file. Everywhere else in the runtime goes through either the
// Type.mapGet/mapHas/mapPut/mapRemove/mapSize/mapEntries accessors below
// (O(log32 n), no materialization - required for any point-access call site
// that used to be O(1) against a plain object, or it silently becomes
// O(n log n): see the accessors' own comments) or through `.data` (the
// materialize-once compatibility view every existing O(n) consumer - fold,
// keys/values/to_list, inspect, the serializer - keeps reading unchanged,
// same trick as ConsCell.data above).
class TrieMap {
  // True private field (see ConsCell.#data above for why): caches the
  // materialized .data view without `data` ever becoming an own property,
  // so deepStrictEqual - which only ever compares own enumerable
  // properties and so never invokes a prototype getter - can't observe
  // whether .data happens to have been read yet. That asymmetry is exactly
  // what broke hundreds of existing tests the first time this was wired
  // in: any code path that happened to read a map's .data before a test's
  // own comparison ran (inspect, error formatting, serialization, ...)
  // made that specific map instance compare unequal to a freshly-built,
  // never-read "expected" value with identical logical content.
  #data;

  // _order: encoded keys in insertion order (first-occurrence position,
  // matching a plain {} object literal's semantics), tracked separately
  // from the trie itself - map_data.mjs's trie is deliberately
  // order-agnostic (see that module's doc), so insertion order, which
  // callers (keys/1, to_list/1, inspect, ...) genuinely observe, lives
  // here instead. Keeping it out of the trie's own node shape is what
  // makes two independently-built maps with identical entries in the
  // identical order come out byte-reproducible: an earlier version baked a
  // seq number into every leaf to get the same effect, and that made the
  // trie's shape depend on unrelated global state, breaking deepStrictEqual
  // for logically-identical maps built via different code paths.
  //
  // A singly-linked chain ({key, next} nodes, null-terminated), NOT a flat
  // array - a real (if rare, all real-world load-bearing on Setu's
  // Holoprint.Workspace grid) perf bug the array version had: mapMerge's
  // map1._order.slice() copied map1's *entire* order array on every merge
  // call, no matter how few keys map2 actually added - O(size(map1)) on
  // exactly the operation (%{state | k: v} merging a small delta into a
  // large, ever-growing map) the HAMT itself is O(log32 n) for. The chain
  // is prepend-only (head = most recently inserted key), so mapPut/mapMerge
  // adding N new keys costs O(N) total for the order side, regardless of
  // how large the map already is - see materializeOrder() below for how
  // this reconstructs true insertion order (oldest-first) on the cold
  // .data/mapEntries path, and mapRemove for the one place removing a key
  // still costs O(size) (unavoidable for a singly-linked structure without
  // giving up O(1) prepend - removes are rare and cold, unlike merge).
  constructor(trie, size, order) {
    this.type = "map";
    this._trie = trie;
    this._size = size;

    // Non-enumerable: deepStrictEqual only compares own *enumerable*
    // properties, so this keeps insertion order out of map equality
    // entirely - matching Elixir's own %{a: 1, b: 2} == %{b: 2, a: 1}
    // (true, order doesn't factor in). Two maps built via genuinely
    // different call paths but with identical content routinely end up
    // with different _order (e.g. a URI parser assembling a result map
    // field-by-field in a different order than a hand-written test
    // fixture) - real, harmless divergence that must not fail equality.
    // Still fully readable via map._order (mapEntries/.data below) -
    // non-enumerable only means "invisible to enumeration/deep-equal",
    // never "inaccessible".
    Object.defineProperty(this, "_order", {
      value: order,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  get data() {
    if (this.#data !== undefined) {
      return this.#data;
    }

    const obj = {};

    for (const encodedKey of materializeOrder(this._order)) {
      obj[encodedKey] = MapData.get(this._trie, encodedKey);
    }

    // Frozen so a write that should have gone through Type.mapPut/mapRemove
    // (and therefore updated the trie) throws immediately in this
    // "use strict" codebase instead of silently mutating a snapshot the
    // trie never sees and that every later .data read would keep serving.
    // Shallow only - a caller that reaches one level deeper
    // (data[k][1] = ...) isn't caught by this and needs to not exist in the
    // first place; see component_registry.mjs's history with exactly that
    // pattern.
    Object.freeze(obj);

    this.#data = obj;

    return obj;
  }
}

export default class Type {
  // Singleton for Type.nil() (#878). `nil` is the single most common atom in
  // the runtime (default action/command target, next_action/next_command
  // when unset, absent map values, ...), and unlike a general value it is
  // never held up for comparison against a *different* nil produced
  // elsewhere - nil is nil. Interning it means repeated
  // Erlang_Maps["put/3"](key, Type.nil(), map) calls on an already-nil field
  // (see hologram.mjs #processActionResult) hit put/3's reference-identity
  // no-op check instead of always allocating both a fresh atom and a fresh
  // map. Atoms are otherwise deliberately not interned - see Type.atom().
  static #nil = {type: "atom", value: "nil"};

  static actionStruct(data = {}) {
    let {name, params, target, delay} = data;

    if (typeof name === "undefined") {
      name = Type.nil();
    }

    if (typeof params === "undefined") {
      params = Type.map();
    }

    if (typeof target === "undefined") {
      target = Type.nil();
    }

    if (typeof delay === "undefined") {
      delay = Type.integer(0);
    }

    return Type.struct("Hologram.Component.Action", [
      [Type.atom("name"), name],
      [Type.atom("params"), params],
      [Type.atom("target"), target],
      [Type.atom("delay"), delay],
    ]);
  }

  static alias(aliasStr) {
    return Type.atom(`Elixir.${aliasStr}`);
  }

  // name is the identity the BEAM gives a function defined inside another one,
  // e.g. "-my_fun/1-fun-0-". The compiler emits it, so a function built by the
  // client runtime rather than by transpiled code carries none.
  static anonymousFunction(arity, clauses, context, name = null) {
    return {
      type: "anonymous_function",
      arity: arity,
      capturedFunction: null,
      capturedModule: null,
      clauses: clauses,
      context: Interpreter.cloneContext(context),
      name: name,
      uniq: ERTS.funSequence.next(),
    };
  }

  static atom(value) {
    return {type: "atom", value: value};
  }

  static bitstring(arg) {
    if (typeof arg === "string") {
      return Bitstring.fromText(arg);
    }

    if (arg.length > 0 && typeof arg[0] === "object") {
      return Bitstring.fromSegments(arg);
    }

    return Bitstring.fromBits(arg);
  }

  static bitstringPattern(segments) {
    return {type: "bitstring_pattern", segments: segments};
  }

  static bitstringSegment(value, modifiers = {}) {
    const type = Type.#getOption(modifiers, "type");
    const size = Type.#getOption(modifiers, "size");
    const unit = Type.#getOption(modifiers, "unit");
    const signedness = Type.#getOption(modifiers, "signedness");
    const endianness = Type.#getOption(modifiers, "endianness");

    return {value, type, size, unit, signedness, endianness};
  }

  static boolean(value) {
    return Type.atom(value.toString());
  }

  static charlist(string) {
    return Type.list(
      Array.from(string, (char) => Type.integer(char.codePointAt(0))),
    );
  }

  static commandStruct(data = {}) {
    let {name, params, target} = data;

    if (typeof name === "undefined") {
      name = Type.nil();
    }

    if (typeof params === "undefined") {
      params = Type.map();
    }

    if (typeof target === "undefined") {
      target = Type.nil();
    }

    return Type.struct("Hologram.Component.Command", [
      [Type.atom("name"), name],
      [Type.atom("params"), params],
      [Type.atom("target"), target],
    ]);
  }

  static componentStruct(data = {}) {
    let {emittedContext, nextAction, nextCommand, nextPage, state} = data;

    if (typeof emittedContext === "undefined") {
      emittedContext = Type.map();
    }

    if (typeof nextAction === "undefined") {
      nextAction = Type.nil();
    }

    if (typeof nextCommand === "undefined") {
      nextCommand = Type.nil();
    }

    if (typeof nextPage === "undefined") {
      nextPage = Type.nil();
    }

    if (typeof state === "undefined") {
      state = Type.map();
    }

    return Type.struct("Hologram.Component", [
      [Type.atom("emitted_context"), emittedContext],
      [Type.atom("next_action"), nextAction],
      [Type.atom("next_command"), nextCommand],
      [Type.atom("next_page"), nextPage],
      [Type.atom("state"), state],
    ]);
  }

  // #878: O(1) `[head | tail]` construction when tail is already a proper
  // list - the tail is shared, not copied. Matches the previous
  // Interpreter.consOperator contract exactly, including the improper-list
  // branch: when tail is anything other than a proper list (already
  // improper, or not a list at all), the result nests it as a single
  // element rather than flattening - a ConsCell is never involved there,
  // since only a proper tail is O(1)-shareable in the first place.
  static cons(head, tail) {
    if (Type.isProperList(tail)) {
      return new ConsCell(head, tail);
    }

    return Type.improperList([head, tail]);
  }

  static consPattern(head, tail) {
    return {type: "cons_pattern", head: head, tail: tail};
  }

  static encodeMapKey(term) {
    switch (term.type) {
      case "anonymous_function":
        return Type.#encodeAnonymousFunctionTypeMapKey(term);

      case "atom":
      case "float":
      case "integer":
        return Type.#encodePrimitiveTypeMapKey(term);

      case "bitstring":
        return Bitstring.serialize(term);

      case "list":
      case "tuple":
        return Type.#encodeEnumTypeMapKey(term);

      case "map":
        return Type.#encodeMapTypeMapKey(term);

      case "reference":
        return Type.#encodeReferenceTypeMapKey(term);
    }
  }

  static errorStruct(aliasStr, message) {
    const data = [
      [Type.atom("__exception__"), Type.boolean(true)],
      [Type.atom("message"), Type.bitstring(message)],
    ];

    return Type.struct(aliasStr, data);
  }

  static float(value) {
    return {type: "float", value: value};
  }

  static functionCapture(
    capturedModule,
    capturedFunction,
    arity,
    clauses,
    context,
  ) {
    return {
      type: "anonymous_function",
      arity: arity,
      capturedFunction: capturedFunction,
      capturedModule: capturedModule,
      clauses: clauses,
      context: Interpreter.buildContext({module: context.module, vars: {}}),
      // A capture is named by what it captures, so it needs no fun name.
      name: null,
      uniq: ERTS.funSequence.next(),
    };
  }

  static improperList(data) {
    if (data.length < 2) {
      throw new HologramInterpreterError(
        "improper list must have at least 2 items, received " +
          Serializer.serialize(data, "client"),
      );
    }

    return {type: "list", data: data, isProper: false};
  }

  static integer(value) {
    if (typeof value !== "bigint") {
      value = BigInt(value);
    }

    return {type: "integer", value: value};
  }

  static isAlias(term) {
    return Type.isAtom(term) && term.value.startsWith("Elixir.");
  }

  static isAnonymousFunction(term) {
    return term.type === "anonymous_function";
  }

  static isAtom(term) {
    return term.type === "atom";
  }

  static isBinary(term) {
    return Type.isBitstring(term) && term.leftoverBitCount === 0;
  }

  static isBitstring(term) {
    return term.type === "bitstring";
  }

  static isBitstringPattern(term) {
    return term.type === "bitstring_pattern";
  }

  static isBoolean(term) {
    return (
      term.type === "atom" && (term.value === "false" || term.value === "true")
    );
  }

  static isCharlist(term) {
    if (!Type.isProperList(term)) {
      return false;
    }

    return term.data.every(
      (elem) => Type.isInteger(elem) && Bitstring.validateCodePoint(elem.value),
    );
  }

  // TODO: check if the pattern is in the ERTS binary patterns registry
  static isCompiledPattern(term) {
    if (!Type.isTuple(term)) return false;

    const data = term.data;
    if (data.length !== 2) return false;

    const algo = data[0];

    return (
      Type.isAtom(algo) &&
      (algo.value === "bm" || algo.value === "ac") &&
      Type.isReference(data[1])
    );
  }

  static isConsPattern(term) {
    return term.type === "cons_pattern";
  }

  static isFalse(term) {
    return Type.isAtom(term) && term.value === "false";
  }

  static isFalsy(term) {
    return Type.isFalse(term) || Type.isNil(term);
  }

  static isFloat(term) {
    return term.type === "float";
  }

  static isImproperList(term) {
    return Type.isList(term) && term.isProper === false;
  }

  static isInteger(term) {
    return term.type === "integer";
  }

  static isKeywordList(term) {
    if (!Type.isList(term)) {
      return false;
    }

    return term.data.every(
      (item) =>
        Type.isTuple(item) &&
        item.data.length === 2 &&
        Type.isAtom(item.data[0]),
    );
  }

  static isConsCell(term) {
    return term.isConsCell === true;
  }

  static isList(term) {
    return term.type === "list";
  }

  static isMap(term) {
    return term.type === "map";
  }

  static isMatchPlaceholder(term) {
    return term.type === "match_placeholder";
  }

  static isNativeValueStruct(term) {
    return Type.isStruct(term, "Hologram.JS.NativeValue");
  }

  static isNil(term) {
    return term.type === "atom" && term.value === "nil";
  }

  static isNumber(term) {
    return Type.isInteger(term) || Type.isFloat(term);
  }

  static isPid(term) {
    return term.type === "pid";
  }

  static isPort(term) {
    return term.type === "port";
  }

  static isProperList(term) {
    return Type.isList(term) && term.isProper === true;
  }

  static isRange(term) {
    return Type.isStruct(term, "Range");
  }

  // Returns true when the term is a tuple of the given arity with the given
  // atom as its first element (the shape of an Erlang record).
  static isRecordTuple(term, tag, arity) {
    return (
      Type.isTuple(term) &&
      term.data.length === arity &&
      term.data[0]?.type === "atom" &&
      term.data[0].value === tag
    );
  }

  static isReference(term) {
    return term.type === "reference";
  }

  // Deps: [:maps.get/3, :maps.is_key/2]
  static isStruct(term, module = null) {
    if (!Type.isMap(term)) return false;

    if (module === null) {
      return Type.isTrue(
        Erlang_Maps["is_key/2"](Type.atom("__struct__"), term),
      );
    }

    return Interpreter.isEqual(
      Erlang_Maps["get/3"](Type.atom("__struct__"), term, Type.nil()),
      Type.alias(module),
    );
  }

  static isTrue(term) {
    return Type.isAtom(term) && term.value === "true";
  }

  static isTruthy(term) {
    return !Type.isFalsy(term);
  }

  static isTuple(term) {
    return term.type === "tuple";
  }

  static isVariablePattern(term) {
    return term.type === "variable_pattern";
  }

  static list(data = []) {
    return {type: "list", data: data, isProper: true};
  }

  // #878: cheap emptiness check that never forces a ConsCell to
  // materialize .data - a cons cell always has a head, so it is never
  // empty by construction, and checking that doesn't need to touch .data
  // at all. Callers must already know `list` isList(); this doesn't
  // re-check.
  static listIsEmpty(list) {
    return !Type.isConsCell(list) && list.data.length === 0;
  }

  static keywordList(data = []) {
    return Type.list(data.map((item) => Type.tuple(item)));
  }

  static map(data = []) {
    const pairs = data.map(([key, value]) => [
      Type.encodeMapKey(key),
      [key, value],
    ]);

    const {root, size} = MapData.fromEntries(pairs);
    let order = null;
    const seen = new Set();

    // Mirrors fromEntries()'s own dedup semantics: first occurrence's
    // position, last occurrence's value (the value already landed in the
    // trie above; here we only need to not double-prepend a duplicate
    // key). Prepending in forward (pairs) order builds the chain with the
    // last first-occurrence key at the head, matching mapPut/mapMerge's
    // own orientation - see materializeOrder().
    for (const [encodedKey] of pairs) {
      if (!seen.has(encodedKey)) {
        seen.add(encodedKey);
        order = {key: encodedKey, next: order};
      }
    }

    return new TrieMap(root, size, order);
  }

  // #878: O(log32 n) point read, returns the [keyTerm, valueTerm] pair (or
  // undefined) - same shape every existing `map.data[encodedKey]` site
  // already expects, so callers keep doing `Type.mapGet(map, encodedKey)[1]`
  // for the value. `encodedKey` is a pre-encoded Type.encodeMapKey() string,
  // not a boxed term - matches what every BIF here already computes once
  // and reuses, rather than re-encoding on every accessor call.
  static mapGet(map, encodedKey) {
    return MapData.get(map._trie, encodedKey);
  }

  static mapHas(map, encodedKey) {
    return MapData.has(map._trie, encodedKey);
  }

  // [[encodedKey, [keyTerm, valueTerm]], ...] in insertion order. For
  // genuinely O(n) consumers that need encoded keys directly (e.g. merge's
  // no-op check below) without paying .data's extra freeze/cache step for a
  // one-shot traversal. The trie itself (map_data.mjs) doesn't track
  // insertion order - see TrieMap's _order field - so this walks _order and
  // does one point-read per key rather than delegating to MapData.entries().
  static mapEntries(map) {
    return materializeOrder(map._order).map((encodedKey) => [
      encodedKey,
      MapData.get(map._trie, encodedKey),
    ]);
  }

  static mapSize(map) {
    return map._size;
  }

  // #878: O(log32 n) point write. Reference-identity no-op check lives here
  // (not in map_data.mjs, which always writes) - putting back a value
  // that's already stored, reference-identical, returns the same map
  // instead of paying the path-copy. Reference identity only, never
  // isStrictlyEqual: this check itself must stay O(log32 n), and a deep
  // walk would cost more than the write it's meant to save.
  static mapPut(map, encodedKey, pair) {
    const existing = MapData.get(map._trie, encodedKey);

    if (existing !== undefined && existing[1] === pair[1]) {
      return map;
    }

    const {root, added} = MapData.put(map._trie, encodedKey, pair);

    if (!added) {
      return new TrieMap(root, map._size, map._order);
    }

    // O(1): prepend to the chain, share the rest - see TrieMap's _order doc.
    return new TrieMap(root, map._size + 1, {
      key: encodedKey,
      next: map._order,
    });
  }

  // #878: no-op (same map reference) if encodedKey is absent. O(size(map)):
  // removing an arbitrary key from a singly-linked chain needs rebuilding
  // every node from the head down to (and past) the removed one - the one
  // place this representation doesn't beat the old array, but removes are
  // rare/cold, unlike merge (see TrieMap's _order doc).
  static mapRemove(map, encodedKey) {
    const {root, removed} = MapData.remove(map._trie, encodedKey);

    if (!removed) {
      return map;
    }

    const newestFirst = [];
    let node = map._order;

    while (node !== null) {
      if (node.key !== encodedKey) {
        newestFirst.push(node.key);
      }

      node = node.next;
    }

    let order = null;

    for (let i = newestFirst.length - 1; i >= 0; --i) {
      order = {key: newestFirst[i], next: order};
    }

    return new TrieMap(root, map._size - 1, order);
  }

  // #878: map2's keys overwrite map1's at their *shared* trie positions -
  // O(size(map2) * log32 size(map1)) for the trie, O(size(map2)) for order
  // tracking - not a full O(size(map1)) rebuild of either. Matches
  // {...map1.data, ...map2.data}'s old semantics exactly: an overwritten
  // key keeps map1's insertion position, a genuinely new key from map2 is
  // appended in map2's own order. Critically, `order` starts as map1._order
  // *by reference* (no copy) - see TrieMap's _order doc for why copying it
  // here was a real O(size(map1))-per-merge perf bug on exactly the
  // large-map-plus-small-delta shape merge/2 exists for.
  static mapMerge(map1, map2) {
    let trie = map1._trie;
    let size = map1._size;
    let order = map1._order;

    for (const [encodedKey, pair] of Type.mapEntries(map2)) {
      const result = MapData.put(trie, encodedKey, pair);
      trie = result.root;

      if (result.added) {
        ++size;
        order = {key: encodedKey, next: order};
      }
    }

    return new TrieMap(trie, size, order);
  }

  static matchPattern(left, right) {
    return {type: "match_pattern", left: left, right: right};
  }

  static matchPlaceholder() {
    return {type: "match_placeholder"};
  }

  static maybeNormalizeNumberTerms(term1, term2) {
    const type =
      Type.isFloat(term1) || Type.isFloat(term2) ? "float" : "integer";

    let value1, value2;

    if (type === "float" && Type.isInteger(term1)) {
      value1 = Type.float(Number(term1.value));
    } else {
      value1 = term1;
    }

    if (type === "float" && Type.isInteger(term2)) {
      value2 = Type.float(Number(term2.value));
    } else {
      value2 = term2;
    }

    return [type, value1, value2];
  }

  static nativeValueStruct(jsType, boxedValue) {
    return Type.struct("Hologram.JS.NativeValue", [
      [Type.atom("type"), Type.atom(jsType)],
      [Type.atom("value"), boxedValue],
    ]);
  }

  static nil() {
    return Type.#nil;
  }

  static pid(node, segments, origin = "server") {
    return {type: "pid", node: node, origin: origin, segments: segments};
  }

  static port(node, segments, origin = "server") {
    return {type: "port", node: node, origin: origin, segments: segments};
  }

  static range(first, last, step) {
    return Type.struct("Range", [
      [Type.atom("first"), Type.integer(first)],
      [Type.atom("last"), Type.integer(last)],
      [Type.atom("step"), Type.integer(step)],
    ]);
  }

  static reference(node, creation, idWords) {
    return {
      type: "reference",
      node: node,
      creation: creation,
      idWords: idWords,
    };
  }

  static string(value) {
    return {type: "string", value: value};
  }

  static struct(aliasStr, data) {
    const key = Type.atom("__struct__");
    const value = Type.alias(aliasStr);

    return Type.map(data.concat([[key, value]]));
  }

  static taskStruct(mfa, owner, ref, pid = Type.nil()) {
    return Type.struct("Task", [
      [Type.atom("mfa"), mfa],
      [Type.atom("owner"), owner],
      [Type.atom("pid"), pid],
      [Type.atom("ref"), ref],
    ]);
  }

  static tuple(data = []) {
    return {type: "tuple", data: data};
  }

  static variablePattern(name) {
    return {type: "variable_pattern", name: name};
  }

  static #encodeAnonymousFunctionTypeMapKey(anonymousFunction) {
    return "anonymous_function(" + anonymousFunction.uniq + ")";
  }

  static #encodeEnumTypeMapKey(term) {
    const itemsStr = term.data.map((item) => Type.encodeMapKey(item)).join(",");

    return term.type + "(" + itemsStr + ")";
  }

  static #encodeMapTypeMapKey(map) {
    const itemsStr = Object.keys(map.data)
      .sort()
      .map((key) => key + ":" + Type.encodeMapKey(map.data[key][1]))
      .join(",");

    return "map(" + itemsStr + ")";
  }

  static #encodePrimitiveTypeMapKey(term) {
    return `${term.type}(${term.value})`;
  }

  static #encodeReferenceTypeMapKey(term) {
    const localIncarnationId = ERTS.nodeTable.getLocalIncarnationId(
      term.node,
      term.creation,
    );

    return `r${localIncarnationId}.${term.idWords.toReversed().join(".")}`;
  }

  static #getOption(options, key) {
    return typeof options[key] !== "undefined" ? options[key] : null;
  }
}
