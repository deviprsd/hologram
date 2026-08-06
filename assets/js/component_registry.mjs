"use strict";

import ItemCache from "./item_cache.mjs";
import RenderCache from "./render_cache.mjs";
import Type from "./type.mjs";

export default class ComponentRegistry {
  static entries = Type.map();

  static clear() {
    ComponentRegistry.entries = Type.map();
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
      console.log("WIP DIAGNOSTIC: putComponentStruct identity no-op fired for cid", cid);
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
