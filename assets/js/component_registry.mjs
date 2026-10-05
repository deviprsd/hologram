"use strict";

import Interpreter from "./interpreter.mjs";
import ItemCache from "./item_cache.mjs";
import RenderCache from "./render_cache.mjs";
import Type from "./type.mjs";

export default class ComponentRegistry {
  static entries = Type.map();

  // A cid removed by a page transition still needs to be told apart from one that
  // was never real: a dispatch targeting a cid the page just left is a stale race
  // (safe to drop), while a dispatch targeting a cid that never existed anywhere
  // is a genuine bug (should raise). This holds the previous page's cids - one
  // transition of grace, enough to cover an in-flight fetch/timer/observer
  // resolving shortly after put_page - without accumulating every cid from every
  // page ever visited in a long-running SPA session. See isCidKnown().
  static #previousCids = new Set();

  static clear() {
    ComponentRegistry.entries = Type.map();
    ComponentRegistry.#previousCids = new Set();
    RenderCache.clear();
    ItemCache.clear();
  }

  // #878: was an in-place mutation of the struct's next_action field,
  // bypassing putComponentStruct entirely - which meant it never called
  // RenderCache.markDirty, silently violating the invariant
  // render_cache.mjs documents (a struct write always replaces the
  // reference, so struct !== is a sound self-dirty test). Now writes
  // through maps:put/3 and putComponentStruct like every other struct
  // update. In the overwhelmingly common case (next_action already nil),
  // put/3's identity fast path (see erlang/maps.mjs) returns the same
  // struct reference, so this stays cheap - see putComponentStruct.
  static clearNextAction(cid) {
    const componentStruct = ComponentRegistry.getComponentStruct(cid);

    const updatedStruct = Erlang_Maps["put/3"](
      Type.atom("next_action"),
      Type.nil(),
      componentStruct,
    );

    ComponentRegistry.putComponentStruct(cid, updatedStruct);
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/2]
  static getComponentEmittedContext(cid) {
    const componentStruct = ComponentRegistry.getComponentStruct(cid);

    return componentStruct
      ? Erlang_Maps["get/2"](Type.atom("emitted_context"), componentStruct)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/3]
  static getComponentModule(cid) {
    const entry = ComponentRegistry.getEntry(cid);

    return entry
      ? Erlang_Maps["get/3"](Type.atom("module"), entry, null)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/2]
  static getComponentState(cid) {
    const componentStruct = ComponentRegistry.getComponentStruct(cid);

    return componentStruct
      ? Erlang_Maps["get/2"](Type.atom("state"), componentStruct)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/3]
  static getComponentStruct(cid) {
    const entry = ComponentRegistry.getEntry(cid);

    return entry
      ? Erlang_Maps["get/3"](Type.atom("struct"), entry, null)
      : null;
  }

  // null instead of boxed nil is returned by default on purpose, because the function is not used by transpiled code.
  // Deps: [:maps.get/3]
  static getEntry(cid) {
    return Erlang_Maps["get/3"](cid, ComponentRegistry.entries, null);
  }

  // True when cid is registered now, or was registered on the page just left.
  // These are the two cases a dispatcher failure treats as "not a bug" - a stale
  // race, not a real invalid target - and drops with a warning instead of
  // raising. A cid that matches neither was never real on any page the client
  // has been on, which is what actually distinguishes a race from a typo'd or
  // otherwise-invalid target. See #previousCids for why only one page of grace.
  static isCidKnown(cid) {
    return (
      ComponentRegistry.isCidRegistered(cid) ||
      ComponentRegistry.#previousCids.has(Type.encodeMapKey(cid))
    );
  }

  // Deps: [:maps.is_key/2]
  static isCidRegistered(cid) {
    return Type.isTrue(Erlang_Maps["is_key/2"](cid, ComponentRegistry.entries));
  }

  static populate(entries) {
    ComponentRegistry.#previousCids = new Set(
      Type.mapEntries(ComponentRegistry.entries).map(
        ([encodedKey]) => encodedKey,
      ),
    );

    ComponentRegistry.entries = entries;
    RenderCache.clear();
    ItemCache.clear();
  }

  // #878: was an in-place mutation of the struct's props field, bypassing
  // putComponentStruct entirely - same in-place-mutation removal as
  // clearNextAction and putComponentStruct itself (see #878 note there for
  // why entries.data can no longer be mutated directly).
  //
  // Called on every render (see #renderStatefulComponent), not only at init,
  // with a props map #castProps rebuilds fresh from template evaluation each
  // time - so unlike clearNextAction's state value, this key's incoming value
  // is a new object reference even when every entry inside it is unchanged.
  // maps:put/3's own identity fast path (see erlang/maps.mjs) only ever
  // compares references, so it can't catch that case here - deep-equality
  // guard it explicitly, or an unchanged re-render would rebuild the struct
  // (and its whole path-copy) and call RenderCache.markDirty on every render,
  // defeating the memoization #878 exists for.
  static putComponentProps(cid, props) {
    const componentStruct = ComponentRegistry.getComponentStruct(cid);
    const currentProps = Erlang_Maps["get/2"](
      Type.atom("props"),
      componentStruct,
    );

    if (Interpreter.isStrictlyEqual(currentProps, props)) {
      return;
    }

    const updatedStruct = Erlang_Maps["put/3"](
      Type.atom("props"),
      props,
      componentStruct,
    );

    ComponentRegistry.putComponentStruct(cid, updatedStruct);
  }

  // #878: was an in-place mutation of ComponentRegistry.entries.data,
  // which an immutable trie-backed map (map_data.mjs) can't support -
  // entries has to be replaced through maps:put/3 like any other map
  // write. Now that the trie is wired into Type.map, this is back to
  // "Optimized" in the sense the old in-place version was: maps:put/3 ->
  // Type.mapPut path-copies only the O(log32 n) nodes on the changed cid,
  // not the whole entries registry.
  //
  // #878 identity fast path: if the incoming struct is reference-identical
  // to what is already stored, nothing about this cid changed - skip both
  // the write and markDirty entirely. This is the payoff #878 exists for:
  // an action that returns unchanged state gets put/3's own identity
  // no-op (see erlang/maps.mjs), so the struct handed back here is the
  // exact same object already in the registry, and the render this cid
  // (and every ancestor whose descendant-dirtiness check would otherwise
  // trip on it) would have caused becomes zero work instead of a
  // path-copy plus a re-render. Only safe for the struct field - see
  // putEntry below, which can legitimately swap `module` under the same
  // cid and must not skip on a struct/state match alone.
  static putComponentStruct(cid, componentStruct) {
    const entry = ComponentRegistry.getEntry(cid);

    if (
      entry !== null &&
      Erlang_Maps["get/3"](Type.atom("struct"), entry, null) === componentStruct
    ) {
      return;
    }

    const updatedEntry = Erlang_Maps["put/3"](
      Type.atom("struct"),
      componentStruct,
      entry,
    );

    ComponentRegistry.entries = Erlang_Maps["put/3"](
      cid,
      updatedEntry,
      ComponentRegistry.entries,
    );

    RenderCache.markDirty(cid);
  }

  // #878: see putComponentStruct - same in-place-mutation removal.
  static putEntry(cid, entry) {
    ComponentRegistry.entries = Erlang_Maps["put/3"](
      cid,
      entry,
      ComponentRegistry.entries,
    );

    RenderCache.markDirty(cid);
  }
}
