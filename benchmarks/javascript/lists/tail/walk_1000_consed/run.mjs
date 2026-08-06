"use strict";

// Sibling of ../walk_1000, with one deliberate difference: the list here is
// built by 1000 repeated Interpreter.consOperator calls (what transpiled
// Elixir code actually does for `[h | t]` construction, e.g. building an
// accumulator through recursion), not a single Type.list(array) literal.
// That distinction matters as of #878: Type.cons only returns an O(1)
// cons-cell chain when it's the thing constructing the list. A list that
// already exists as a packed array (../walk_1000's fullList) has no cons
// cells to walk regardless of how #878 lands - see that case's README for
// why it's an intentional, unaffected control rather than a bug.

import Erlang from "../../../../../assets/js/erlang/erlang.mjs";
import Interpreter from "../../../../../assets/js/interpreter.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

let consedList = Type.list();
for (let i = 999; i >= 0; --i) {
  consedList = Interpreter.consOperator(Type.integer(i), consedList);
}

benchmark(() => {
  let list = consedList;
  while (!Type.listIsEmpty(list)) {
    list = Erlang["tl/1"](list);
  }
});
