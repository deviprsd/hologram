"use strict";

// Companion to ../put_component_struct_30_components: same 30-live-component
// registry, but writes back the exact struct reference already stored under
// targetCid instead of a genuinely new one each call - the shape an action
// that returns unchanged state actually produces (maps:put/3's identity
// fast path means the "new" struct handed to putComponentStruct after a
// no-op state write is the same object already there). #878 stage 5 adds an
// identity guard to putComponentStruct for exactly this case: skip the
// write and RenderCache.markDirty entirely. See component_registry.mjs.

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
const struct = ComponentRegistry.getComponentStruct(targetCid);

benchmark(() => {
  ComponentRegistry.putComponentStruct(targetCid, struct);
});
