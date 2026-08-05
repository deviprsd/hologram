"use strict";

// Baseline for for_list_keyed/run.mjs - same 30-row list, but without item markers, i.e. the
// shape a {%for} whose generator isn't a single plain variable (or that has no :id and no $key)
// still renders today. Compares against for_list_keyed to show the per-item marker overhead.

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
