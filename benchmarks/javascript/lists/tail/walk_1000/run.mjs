"use strict";

// Models recursive list processing (e.g. a transpiled Elixir function
// pattern-matching `[h | t]` down to `[]`) by repeatedly taking the tail via
// erlang:tl/1, which bottoms out in Interpreter.#listRemainder -
// list.data.slice(fromIndex), an O(n) array copy per step. Walking a full
// 1000-element list this way is therefore O(n^2) today.
//
// #878 note: this specific list is built as a single Type.list(array), a
// packed list with no cons cells - it stays that way (walking it is
// unaffected by stage 4's cons-cell work) because there is nothing to walk
// lazily; the array already exists in full. See ../walk_1000_consed for the
// case #878 actually targets: a list built by repeated consing, which is
// how transpiled `[h | t]` construction really produces one.

import Erlang from "../../../../../assets/js/erlang/erlang.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const items = [];
for (let i = 0; i < 1000; ++i) {
  items.push(Type.integer(i));
}
const fullList = Type.list(items);

benchmark(() => {
  let list = fullList;
  while (list.data.length > 0) {
    list = Erlang["tl/1"](list);
  }
});
