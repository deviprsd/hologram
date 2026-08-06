"use strict";

// Interpreter.consOperator backs every `[h | t]` construction. Today it is
// Type.list([head].concat(tail.data)) - an O(n) array copy per cons, so
// building a list by repeated consing is O(n^2). BEAM cons cells are O(1).
// After stage 4's cons-cell representation, this single cons should be O(1)
// regardless of the tail's length.

import Interpreter from "../../../../../assets/js/interpreter.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const items = [];
for (let i = 0; i < 1000; ++i) {
  items.push(Type.integer(i));
}
const tail = Type.list(items);
const head = Type.integer(-1);

benchmark(() => {
  Interpreter.consOperator(head, tail);
});
