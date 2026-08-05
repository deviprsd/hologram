"use strict";

import ComponentRegistry from "./component_registry.mjs";
import Interpreter from "./interpreter.mjs";
import Type from "./type.mjs";

// Caches each stateful component's last-rendered vnode output, keyed by cid, so an unchanged
// component can return the identical vnode objects instead of re-evaluating its template. Snabbdom's
// own patchVnode() skips a subtree outright when oldVnode === vnode (see vendor/snabbdom
// init.js:patchVnode), so identity reuse turns an unchanged component's diff into an O(1) no-op on
// top of skipping its interpreted template evaluation.
//
// A component's rendered output depends on its descendants' registry state too, not just its own -
// keying reuse only on a component's own props/state/context would let an unrelated ancestor return
// stale cached output on the very render where a deep child's state changed. #encounteredCids is a
// flat, render-order log every stateful component's cid is pushed onto on entry; slicing it between
// the mark taken just after a component pushes its own cid and the mark taken once its template
// finishes rendering yields exactly its descendant cids, with itself excluded - the same
// mark-and-slice technique Renderer already uses for listenerBindings/reachBindings/resizeBindings.
// A cached entry is rejected if any cid marked dirty this render is among its descendants.
export default class RenderCache {
  static #cache = new Map();

  // Cids marked dirty since the last beginRender(), used by isReusable() this render.
  static #dirtyCids = new Set();

  // Accumulates markDirty() calls as they happen, swapped into #dirtyCids at the next beginRender()
  // so a component initializing mid-render (a first-ever appearance) affects only the next render,
  // not decisions already made earlier in this one.
  static #pendingDirtyCids = new Set();

  // Cids touched (kept or replayed) this render, for the end-of-render eviction sweep.
  static #liveCids = new Set();

  static #encounteredCids = [];
  static #formInputVnodes = [];

  static beginRender() {
    $.#dirtyCids = $.#pendingDirtyCids;
    $.#pendingDirtyCids = new Set();
    $.#liveCids = new Set();
    $.#encounteredCids = [];
    $.#formInputVnodes = [];
  }

  // A cid whose cached entry is gone by the time this runs (departed the page, or never cached, e.g.
  // "layout") never had its .elm chain retained anywhere, so there is nothing to clean up beyond
  // dropping the cache entry itself.
  static endRender() {
    for (const cidKey of $.#cache.keys()) {
      if (!$.#liveCids.has(cidKey)) {
        $.#cache.delete(cidKey);
      }
    }
  }

  static clear() {
    $.#cache = new Map();
    $.#dirtyCids = new Set();
    $.#pendingDirtyCids = new Set();
    $.#liveCids = new Set();
    $.#encounteredCids = [];
    $.#formInputVnodes = [];
  }

  static markDirty(cid) {
    $.#pendingDirtyCids.add(Type.encodeMapKey(cid));
  }

  static noteEncountered(cidKey) {
    $.#encounteredCids.push(cidKey);
  }

  static noteFormInput(vnode) {
    if (vnode.data.hook) {
      $.#formInputVnodes.push(vnode);
    }
  }

  // Marks taken right after a component's own cid is logged (so its own cid is excluded from its
  // descendant slice) and right after its form inputs are collected, for descendantsSince()/
  // formInputsSince() to slice from once its template has finished rendering.
  static cidMark() {
    return $.#encounteredCids.length;
  }

  static formInputMark() {
    return $.#formInputVnodes.length;
  }

  static descendantsSince(mark) {
    return new Set($.#encounteredCids.slice(mark));
  }

  static formInputsSince(mark) {
    return $.#formInputVnodes.slice(mark);
  }

  static get(cidKey) {
    return $.#cache.get(cidKey);
  }

  // The memo key: moduleProxy (a cid can change module), props and childrenDom as passed down from
  // the parent (childrenDom compared post-#expandSlots, since that is what #renderStatefulComponent
  // receives), context as passed down (pre-merge with the component's own emitted context - the
  // merged value is a fresh object every render, so identity buys nothing there), parentTagName, the
  // component's own struct (replaced by reference on every state/emitted_context write, see
  // component_registry.mjs putComponentStruct - so struct !== is a sound, O(1) self-dirty test), and
  // descendant dirtiness. Everything else a template can read - defaultTarget, slots - is either
  // replaced unconditionally (defaultTarget becomes cid) or already consumed before this point
  // (slots via #expandSlots), so neither is part of the key.
  static isReusable(
    entry,
    moduleProxy,
    props,
    childrenDom,
    context,
    parentTagName,
  ) {
    if (entry.moduleProxy !== moduleProxy) {
      return false;
    }

    if (entry.parentTagName !== parentTagName) {
      return false;
    }

    if (entry.struct !== ComponentRegistry.getComponentStruct(entry.cid)) {
      return false;
    }

    for (const dirtyKey of $.#dirtyCids) {
      if (entry.descendantCids.has(dirtyKey)) {
        return false;
      }
    }

    if (!Interpreter.isStrictlyEqual(entry.props, props)) {
      return false;
    }

    if (!$.#isChildrenDomEqual(entry.childrenDom, childrenDom)) {
      return false;
    }

    if (!Interpreter.isStrictlyEqual(entry.context, context)) {
      return false;
    }

    return true;
  }

  static put(cidKey, entry) {
    $.#cache.set(cidKey, entry);
    $.#markLive(cidKey, entry.descendantCids);
  }

  static replay(entry) {
    $.#markLive(entry.cidKey, entry.descendantCids);

    return entry;
  }

  static #markLive(cidKey, descendantCids) {
    $.#liveCids.add(cidKey);

    for (const descendantCidKey of descendantCids) {
      $.#liveCids.add(descendantCidKey);
    }
  }

  // Empty/empty is the common case (most components take no children) and is worth a fast path, since
  // isStrictlyEqual() would otherwise walk both (empty) lists to reach the same answer.
  static #isChildrenDomEqual(childrenDomA, childrenDomB) {
    if (
      Type.isList(childrenDomA) &&
      Type.isList(childrenDomB) &&
      childrenDomA.data.length === 0 &&
      childrenDomB.data.length === 0
    ) {
      return true;
    }

    return Interpreter.isStrictlyEqual(childrenDomA, childrenDomB);
  }
}

const $ = RenderCache;
