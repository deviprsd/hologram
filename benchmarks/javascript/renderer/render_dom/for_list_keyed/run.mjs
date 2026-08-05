"use strict";

// Same 30-row list as for_list_unkeyed/run.mjs, but with the item marker pair
// Hologram.Template.Marker.item_node/4 wraps around each row - the shape a {%for} with a single
// plain-variable generator (or an explicit $key) actually renders. Compares against
// for_list_unkeyed to show the per-item marker overhead: two extra comment nodes per row.

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
    ]),
    Type.list([
      Type.tuple([Type.atom("text"), Type.bitstring(`Item ${index}`)]),
    ]),
  ]);

const itemMarker = (index, side) =>
  Type.tuple([
    Type.atom("public_comment"),
    Type.list([
      Type.tuple([
        Type.atom("text"),
        Type.bitstring(`[h:bench:0:${index}:${side}]`),
      ]),
    ]),
  ]);

const rows = Array.from({length: ROW_COUNT}, (_, i) => {
  const index = i + 1;
  return [itemMarker(index, "o"), liNode(index), itemMarker(index, "c")];
}).flat();

const node = Type.tuple([
  Type.atom("element"),
  Type.bitstring("ul"),
  Type.list(),
  Type.list(rows),
]);

benchmark(() => {
  Renderer.renderDom(node, context, slots, defaultTarget);
});
