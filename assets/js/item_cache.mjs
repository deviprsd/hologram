"use strict";

import Bitstring from "./bitstring.mjs";
import Interpreter from "./interpreter.mjs";
import Type from "./type.mjs";

// Per-item memoization for keyed `{%for}` loops, sibling to RenderCache (render_cache.mjs) but at
// the granularity of one item instead of one component. Compiled keyed `{%for}` bodies are wrapped
// in a call to Hologram.Template.Marker.memoized_item/5 (see lib/hologram/template/dom.ex and
// assets/js/elixir/hologram/template/marker.mjs) instead of being evaluated unconditionally, so a
// dirty component's re-render can skip re-interpreting a row whose own inputs didn't change.
//
// Cached by call site (a block's hash+index, stable per template occurrence) plus the item's own
// key, since one call site produces one cache entry per distinct item across a render. Guarded by
// a snapshot of the specific free variables the item body's AST references - computed once at
// compile time (Hologram.Template.DOM's free-variable pass), not discovered at runtime, since the
// enclosing scope generally holds vars the body never reads (e.g. a scroll position only the
// *generator* expression consumes) and a whole-scope guard would rarely hit.
//
// Caches the item's DOM term (the interpreted template output), not the rendered vnode: rows
// reorder far more than components do, and vdom.mjs's dedupeKeys mutates vnode .key in place, so
// reusing a vnode across a position change would be unsound. A hit
// still pays the (cheap) phase-B render step - renderDom - same as any unmemoized item; only
// phase A (interpreting the item's template body) is skipped, which is the expensive part on a
// non-trivial row template.
//
// Known limitation: a body calling something render-varying but untracked (DateTime.utc_now/0,
// :rand.uniform/0) freezes on a hit. Unlike RenderCache, which invalidates on any state/props/
// context change, a scoped per-item guard has no way to see such a call and won't re-evaluate it.
export default class ItemCache {
  static #cache = new Map();
  static #liveKeys = new Set();
  static #hits = 0;
  static #misses = 0;

  static beginRender() {
    $.#liveKeys = new Set();
    $.#hits = 0;
    $.#misses = 0;
  }

  // A cache key not touched this render belongs to an item that scrolled out of the window (or
  // was removed) - dropping it is what makes scrolling away and back a correct miss instead of
  // serving a since-evicted-from-the-real-DOM item's stale term.
  static endRender() {
    for (const cacheKey of $.#cache.keys()) {
      if (!$.#liveKeys.has(cacheKey)) {
        $.#cache.delete(cacheKey);
      }
    }
  }

  static clear() {
    $.#cache = new Map();
    $.#liveKeys = new Set();
    $.#hits = 0;
    $.#misses = 0;
  }

  static get hits() {
    return $.#hits;
  }

  static get misses() {
    return $.#misses;
  }

  // key is nil for an item the compiled auto-key/explicit-key expression couldn't turn into safe
  // marker text (see Hologram.Template.Marker.key_from_value/1) - it has no cross-render identity
  // to cache by, so it's evaluated fresh every render, same as before this cache existed.
  static memoizedItem(key, hash, index, guards, itemFun) {
    if (Type.isNil(key)) {
      return Interpreter.callAnonymousFunction(itemFun, []);
    }

    const cacheKey = `${Bitstring.toText(hash)}:${index.value}:${Bitstring.toText(key)}`;

    // Lets a live tab A/B the feature without a server restart or bundle rebuild - comparing
    // across those is what made an earlier measurement in this codebase's history unreadable.
    // Still evaluates and stores, so re-enabling doesn't start from an artificially stale cache.
    if (globalThis.hologramItemMemoDisabled) {
      const dom = Interpreter.callAnonymousFunction(itemFun, []);
      $.#cache.set(cacheKey, {guards, dom});
      $.#liveKeys.add(cacheKey);
      return dom;
    }

    const entry = $.#cache.get(cacheKey);

    if (entry !== undefined && $.#guardsEqual(entry.guards, guards)) {
      $.#liveKeys.add(cacheKey);
      $.#hits += 1;
      return entry.dom;
    }

    const dom = Interpreter.callAnonymousFunction(itemFun, []);

    $.#cache.set(cacheKey, {guards, dom});
    $.#liveKeys.add(cacheKey);
    $.#misses += 1;

    return dom;
  }

  static #guardsEqual(previous, current) {
    if (previous.length !== current.length) {
      return false;
    }

    for (let i = 0; i < previous.length; i += 1) {
      if (!$.#guardEqual(previous[i], current[i])) {
        return false;
      }
    }

    return true;
  }

  // Scalar-only value equality (integer, float, atom incl. nil/boolean, bitstring); anything else
  // (maps, lists, tuples, structs) falls back to reference equality. Never a deep
  // isStrictlyEqual walk on a composite term here - see #878's own established discipline: that
  // would cost more than the item evaluation this cache exists to save.
  static #guardEqual(a, b) {
    if (a === b) {
      return true;
    }

    if ($.#isScalar(a) && $.#isScalar(b)) {
      return Interpreter.isStrictlyEqual(a, b);
    }

    return false;
  }

  static #isScalar(term) {
    return (
      Type.isAtom(term) ||
      Type.isBitstring(term) ||
      Type.isInteger(term) ||
      Type.isFloat(term)
    );
  }
}

const $ = ItemCache;
