"use strict";

// Same 30-row list as for_list_unkeyed/run.mjs, but with each row carrying the "$key" attribute
// Hologram.Template.DOM.add_slot_keys/2 injects on every keyable element (see also
// Renderer.#renderSlotKey) - the shape a {%for} loop actually renders. Compares against
// for_list_unkeyed to show the per-item key-processing overhead (Renderer.#renderSlotKey plus
// snabbdom's keyed diffing) now that reconciliation happens by attribute rather than by
// comment-marker bracketing.

import Renderer from "../../../../../assets/js/renderer.mjs";
import Type from "../../../../../assets/js/type.mjs";

import {benchmark} from "../../../support/helpers.mjs";
import {defineRuntimeGlobals} from "../../../../../test/javascript/support/helpers.mjs";

defineRuntimeGlobals();

const context = Type.map();
const defaultTarget = Type.bitstring("my_default_target");
const slots = Type.keywordList();

const ROW_COUNT = 30;

const liNode = (index) =>
  Type.tuple([
    Type.atom("element"),
    Type.bitstring("li"),
    Type.list([
      Type.tuple([
        Type.bitstring("id"),
        Type.list([
          Type.tuple([Type.atom("text"), Type.bitstring(String(index))]),
        ]),
      ]),
      Type.tuple([
        Type.bitstring("$key"),
        Type.list([
          Type.tuple([Type.atom("text"), Type.bitstring(`bench:${index}`)]),
        ]),
      ]),
    ]),
    Type.list([
      Type.tuple([Type.atom("text"), Type.bitstring(`Item ${index}`)]),
    ]),
  ]);

const rows = Array.from({length: ROW_COUNT}, (_, i) => liNode(i + 1));

const node = Type.tuple([
  Type.atom("element"),
  Type.bitstring("ul"),
  Type.list(),
  Type.list(rows),
]);

benchmark(() => {
  Renderer.renderDom(node, context, slots, defaultTarget);
});
