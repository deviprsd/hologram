"use strict";

// Baseline for for_list_keyed/run.mjs - same 30-row list, but with no "$key" attribute on any
// row. No real {%for} loop output looks like this on its own (every keyable element gets a
// "$key" - see Hologram.Template.DOM.add_slot_keys/2), but it isolates the per-item key-reading
// and keyed-diffing cost that for_list_keyed pays.

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
