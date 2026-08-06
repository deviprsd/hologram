"use strict";

// Baseline for #878: puts a genuinely new key into a 100-key map. Unlike the
// put_no_op case, this must always allocate. Today it's Type.cloneMap's O(n)
// shallow copy of the whole hashtable object. After stage 3's HAMT lands,
// this should cost O(log32 n) - only the trie nodes on the changed path.

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

const key = Type.atom("key_new");
const value = Type.integer(999);

benchmark(() => {
  Erlang_Maps["put/3"](key, value, map);
});
