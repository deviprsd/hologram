"use strict";

// #878 canary: ComponentRegistry.putComponentStruct/putEntry used to mutate
// ComponentRegistry.entries.data in place - incompatible with an immutable
// trie-backed map (map_data.mjs), so they now write through
// Erlang_Maps["put/3"] instead. Until the trie is actually wired into
// Type.map, that write-through costs a full Type.cloneMap of the whole
// entries registry per call, not a path-copy of just the changed cid.
// This measures that temporary cost on a moderately busy page (30 live
// components) with a genuinely different struct each call (not a no-op -
// see maps/put_no_op for that case), so it can be re-run once the trie
// lands to confirm the O(n) -> O(log32 n) improvement, and to catch a
// regression if it doesn't materialize.

import ComponentRegistry from "../../../../../assets/js/component_registry.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

function buildStruct(n) {
  return Type.struct("Component", [
    [Type.atom("emitted_context"), Type.map()],
    [Type.atom("next_action"), Type.nil()],
    [Type.atom("next_command"), Type.nil()],
    [Type.atom("next_page"), Type.nil()],
    [Type.atom("state"), Type.map([[Type.atom("count"), Type.integer(n)]])],
  ]);
}

for (let i = 0; i < 30; ++i) {
  const cid = Type.bitstring(`cid_${i}`);
  const entry = Type.map([
    [Type.atom("module"), Type.atom("MyComponent")],
    [Type.atom("struct"), buildStruct(i)],
  ]);

  ComponentRegistry.putEntry(cid, entry);
}

const targetCid = Type.bitstring("cid_15");
let n = 0;

benchmark(() => {
  ComponentRegistry.putComponentStruct(targetCid, buildStruct(n++));
});
