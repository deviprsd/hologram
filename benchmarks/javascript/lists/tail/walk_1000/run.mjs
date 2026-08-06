"use strict";

// Models recursive list processing (e.g. a transpiled Elixir function
// pattern-matching `[h | t]` down to `[]`) by repeatedly taking the tail via
// erlang:tl/1, which bottoms out in Interpreter.#listRemainder -
// list.data.slice(fromIndex), an O(n) array copy per step. Walking a full
// 1000-element list this way is therefore O(n^2) today. After stage 4's
// cons-cell representation, each tl/1 step should be O(1), making the whole
// walk O(n).

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
