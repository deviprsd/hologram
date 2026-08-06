"use strict";

// Baseline for #878 (structural sharing): puts a key back with its own current
// value, i.e. a no-op write, into a 100-key map. Today this pays the full
// O(n) container copy in Type.cloneMap regardless of whether anything
// changed. After stage 1 lands the identity short-circuit in
// Erlang_Maps["put/3"], this should collapse toward O(1) and return the same
// map reference.

import Erlang_Maps from "../../../../../assets/js/erlang/maps.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const entries = [];
for (let i = 0; i < 100; ++i) {
  entries.push([Type.atom(`key_${i}`), Type.integer(i)]);
}
const map = Type.map(entries);

const key = Type.atom("key_50");
const value = Type.integer(50);

benchmark(() => {
  Erlang_Maps["put/3"](key, value, map);
});
