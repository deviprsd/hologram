"use strict";

// Models the shape of every `%{m | k: v}` update - transformer.ex compiles
// that syntax to Map.merge/2 (see transformer.ex ~line 304), landing here as
// Erlang_Maps["merge/2"]. map1 is a 20-key state map (a realistic component
// state size); map2 is the single changed key. Today this is
// {...map1.data, ...map2.data} - a full O(n) copy of map1 to change one key.
// After stage 1's identity short-circuit, this should return map1 unchanged
// when the value being merged in is already reference-identical, and after
// stage 3's HAMT it should cost O(log32 n) even on a real change.

import Erlang_Maps from "../../../../../assets/js/erlang/maps.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const entries = [];
for (let i = 0; i < 20; ++i) {
  entries.push([Type.atom(`key_${i}`), Type.integer(i)]);
}
const map1 = Type.map(entries);

const map2 = Type.map([[Type.atom("key_10"), Type.integer(999)]]);

benchmark(() => {
  Erlang_Maps["merge/2"](map1, map2);
});
