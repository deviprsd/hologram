"use strict";

// Regression case for #878: merges 2 brand-new keys into a 5000-key map -
// the shape of Holoprint.Workspace's row_cache accumulating chunks on every
// scroll (Map.merge(row_cache, tupled_chunks), workspace.ex), not the fixed
// small map1 maps/merge/single_key_into_20 covers. That benchmark never
// caught a real bug: Type.mapMerge's order-tracking used to copy map1's
// *entire* insertion-order array on every call (`map1._order.slice()`),
// regardless of how few keys map2 added - O(size(map1)) on exactly the
// large-map-plus-small-delta operation the underlying HAMT is O(log32 n)
// for. Confirmed live against Setu's /dev/holoprint/workspace (10k-row
// grid): page-render time climbed from ~50ms to 400+ms as row_cache grew,
// not fixed by #878 stages 1-5 until this was found and fixed (TrieMap's
// _order is now a prepend-shared linked chain, not a flat array - see
// type.mjs). This benchmark exists so that regression can't land silently
// again: map1 here is intentionally 250x larger than
// maps/merge/single_key_into_20's, so an O(size(map1)) order-copy bug shows
// up as a clear scaling difference between the two, not just a bigger
// absolute number.

import Erlang_Maps from "../../../../../assets/js/erlang/maps.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const entries = [];
for (let i = 0; i < 5000; ++i) {
  entries.push([Type.atom(`key_${i}`), Type.integer(i)]);
}
const map1 = Type.map(entries);

const map2 = Type.map([
  [Type.atom("new_key_a"), Type.integer(-1)],
  [Type.atom("new_key_b"), Type.integer(-2)],
]);

benchmark(() => {
  Erlang_Maps["merge/2"](map1, map2);
});
