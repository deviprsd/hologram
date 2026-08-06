"use strict";

// End-to-end shape of a single `put_state(component, :key, value)` action, as
// actually processed by Hologram.#processActionResult (hologram.mjs
// ~line 1138). Per PLANNING for #878, one such action costs four full map
// copies today:
//
//   1. Map.put(state, key, value)              - component.ex put_state/3
//   2. %{component | state: new_state}          -> Map.merge/2 (struct update,
//                                                  transformer.ex ~line 304)
//   3. put/3 nil next_action  (hologram.mjs ~line 1166)
//   4. put/3 nil next_command (hologram.mjs ~line 1172)
//
// The component struct has 5 keys (component.ex defstruct); state here is a
// realistic 20-key component state map. After stages 1/3, steps 3-4 become
// no-ops (next_action/next_command are already nil almost always) and step 2
// only copies the changed key's path, not the whole struct.

import Erlang_Maps from "../../../../../assets/js/erlang/maps.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const stateEntries = [];
for (let i = 0; i < 20; ++i) {
  stateEntries.push([Type.atom(`key_${i}`), Type.integer(i)]);
}
const state = Type.map(stateEntries);

const component = Type.struct("Component", [
  [Type.atom("emitted_context"), Type.map()],
  [Type.atom("next_action"), Type.nil()],
  [Type.atom("next_command"), Type.nil()],
  [Type.atom("next_page"), Type.nil()],
  [Type.atom("state"), state],
]);

const changedKey = Type.atom("key_10");
const changedValue = Type.integer(999);

benchmark(() => {
  // 1. Map.put(state, key, value)
  const newState = Erlang_Maps["put/3"](changedKey, changedValue, state);

  // 2. %{component | state: new_state} -> Map.merge/2
  const stateUpdate = Type.map([[Type.atom("state"), newState]]);
  let newComponent = Erlang_Maps["merge/2"](component, stateUpdate);

  // 3. put/3 nil next_action
  newComponent = Erlang_Maps["put/3"](
    Type.atom("next_action"),
    Type.nil(),
    newComponent,
  );

  // 4. put/3 nil next_command
  Erlang_Maps["put/3"](Type.atom("next_command"), Type.nil(), newComponent);
});
