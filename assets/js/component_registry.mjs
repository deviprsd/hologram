"use strict";

import ItemCache from "./item_cache.mjs";
import RenderCache from "./render_cache.mjs";
import Type from "./type.mjs";

export default class ComponentRegistry {
  static entries = Type.map();

  // Bug #1002: a cid's action dispatches used to read-then-commit with no
  // exclusion, so a tight synchronous burst of dispatches against the same
  // cid (fast key-repeat, rapid clicks) all read the same pre-burst struct
  // and only the last commit survived - see runExclusive(). Keyed by
  // Type.encodeMapKey(cid) (the same idiom RenderCache.markDirty uses for a
  // cid-keyed native Map), mapping to a Promise that never rejects - see
  // runExclusive()'s #occupy.
  static #actionChains = new Map();

  static clear() {
    ComponentRegistry.entries = Type.map();
    ComponentRegistry.#actionChains = new Map();
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

  // Deps: [:maps.is_key/2]
  static isCidRegistered(cid) {
    return Type.isTrue(Erlang_Maps["is_key/2"](cid, ComponentRegistry.entries));
  }

  static populate(entries) {
    ComponentRegistry.entries = entries;
    ComponentRegistry.#actionChains = new Map();
    RenderCache.clear();
    ItemCache.clear();
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

  // Bug #1002: serializes read-then-commit cycles against the same cid, so a
  // burst of dispatches against one cid can't all read the same pre-burst
  // struct. fn is a thunk: return null/undefined once it has already
  // committed synchronously, or a Promise that settles once its commit has
  // landed.
  //
  // Idle cid (no action in flight - the overwhelming common case): fn()
  // runs synchronously, right here, with nothing new wrapped around it - a
  // synchronous throw propagates synchronously out of runExclusive exactly
  // as it would have out of a bare fn() call. This is load-bearing: making
  // every dispatch async would turn every action error into a rejected
  // Promise, which is exactly what hologram.mjs's executeAction comment
  // says must not happen (ChromeDriver/Wallaby's synchronous "error" event
  // detection).
  //
  // Busy cid: queues behind the in-flight chain instead of racing it. By
  // the time the queued fn() runs, the prior occupant's commit has already
  // landed, because #occupy's gate is derived from the SAME promise
  // executeAction's own .then() chains off of registered first - see
  // #executeActionNow.
  static runExclusive(cid, fn) {
    const key = Type.encodeMapKey(cid);
    const pending = ComponentRegistry.#actionChains.get(key);

    if (pending === undefined) {
      const result = fn();
      return result instanceof Promise
        ? ComponentRegistry.#occupy(key, result)
        : null;
    }

    const ran = pending.then(() => {
      // The cid's page may have navigated away while this was queued
      // (populate()/clear() already dropped the chain entry that gated us,
      // but that can't cancel a continuation already attached to it) -
      // running against a cid the current registry no longer knows about
      // would crash callNamedFunction on a null module. No-op instead.
      if (!ComponentRegistry.isCidRegistered(cid)) {
        return null;
      }

      try {
        return fn();
      } catch (error) {
        // Can no longer throw synchronously out of runExclusive - this is
        // inside a microtask reaction. Re-surface on the next microtask
        // instead of swallowing it, so it still reaches the window "error"
        // listener Hologram.#init() installs, same reporting channel the
        // idle-cid path uses.
        queueMicrotask(() => {
          throw error;
        });

        return null;
      }
    });

    return ComponentRegistry.#occupy(key, ran);
  }

  // Stores a never-rejecting gate for `key` derived from `settleSignal`, and
  // arranges for the entry to be dropped once it settles - unless a later
  // call has already replaced it with its own gate, in which case that
  // later call owns the teardown.
  static #occupy(key, settleSignal) {
    const gate = settleSignal.then(
      () => {},
      () => {},
    );

    ComponentRegistry.#actionChains.set(key, gate);

    gate.then(() => {
      if (ComponentRegistry.#actionChains.get(key) === gate) {
        ComponentRegistry.#actionChains.delete(key);
      }
    });

    return gate;
  }
}
