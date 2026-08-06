"use strict";

import {
  assert,
  defineRuntimeGlobals,
  initComponentRegistryEntry,
  sinon,
} from "./support/helpers.mjs";

import ComponentRegistry from "../../assets/js/component_registry.mjs";
import RenderCache from "../../assets/js/render_cache.mjs";
import Type from "../../assets/js/type.mjs";

defineRuntimeGlobals();

const cid1 = Type.bitstring("my_component_1");
const cid2 = Type.bitstring("my_component_2");
const cid3 = Type.bitstring("my_component_3");
const cid4 = Type.bitstring("my_component_4");

const module1 = Type.alias("MyModule1");
const module2 = Type.alias("MyModule2");
const module3 = Type.alias("MyModule3");

const emittedContext1 = Type.map([
  [Type.atom("context_1a"), Type.integer(11)],
  [Type.atom("context_1b"), Type.integer(12)],
]);

const emittedContext2 = Type.map([
  [Type.atom("context_2a"), Type.integer(21)],
  [Type.atom("context_2b"), Type.integer(22)],
]);

const emittedContext3 = Type.map([
  [Type.atom("context_3a"), Type.integer(31)],
  [Type.atom("context_3b"), Type.integer(32)],
]);

const state1 = Type.map([
  [Type.atom("state_1a"), Type.integer(101)],
  [Type.atom("state_1b"), Type.integer(102)],
]);

const state2 = Type.map([
  [Type.atom("state_2a"), Type.integer(201)],
  [Type.atom("state_2b"), Type.integer(202)],
]);

const state3 = Type.map([
  [Type.atom("state_3a"), Type.integer(301)],
  [Type.atom("state_3b"), Type.integer(302)],
]);

const struct1 = Type.componentStruct({
  emittedContext: emittedContext1,
  state: state1,
});

const struct2 = Type.componentStruct({
  emittedContext: emittedContext2,
  state: state2,
});

const struct3 = Type.componentStruct({
  emittedContext: emittedContext3,
  state: state3,
});

const entry1 = Type.map([
  [Type.atom("module"), module1],
  [Type.atom("struct"), struct1],
]);

const entry2 = Type.map([
  [Type.atom("module"), module2],
  [Type.atom("struct"), struct2],
]);

const entry3 = Type.map([
  [Type.atom("module"), module3],
  [Type.atom("struct"), struct3],
]);

describe("ComponentRegistry", () => {
  beforeEach(() => {
    ComponentRegistry.entries = Type.map([
      [cid1, entry1],
      [cid2, entry2],
    ]);
  });

  it("clear()", () => {
    assert.deepStrictEqual(
      ComponentRegistry.entries,
      Type.map([
        [cid1, entry1],
        [cid2, entry2],
      ]),
    );

    ComponentRegistry.clear();

    assert.deepStrictEqual(ComponentRegistry.entries, Type.map());
  });

  describe("clearNextAction()", () => {
    it("clears next_action from the component struct in the registry", () => {
      const action = Type.actionStruct({
        name: Type.atom("my_action"),
        params: Type.map(),
        target: Type.bitstring("my_target"),
      });

      const struct = Type.componentStruct({ nextAction: action });

      const entry = Type.map([
        [Type.atom("module"), Type.alias("MyModule")],
        [Type.atom("struct"), struct],
      ]);

      ComponentRegistry.entries = Type.map([[cid3, entry]]);

      ComponentRegistry.clearNextAction(cid3);

      const updatedStruct = ComponentRegistry.getComponentStruct(cid3);

      assert.deepStrictEqual(
        Erlang_Maps["get/2"](Type.atom("next_action"), updatedStruct),
        Type.nil(),
      );
    });

    it("marks the cid dirty in RenderCache (#878)", () => {
      // Previously an in-place mutation of the struct that bypassed
      // putComponentStruct entirely, so this never happened - a real
      // (if narrow) correctness gap in the RenderCache.isReusable
      // invariant it's supposed to be part of. Now routes through
      // putComponentStruct like any other struct write.
      const struct = Type.componentStruct({
        nextAction: Type.actionStruct({ name: Type.atom("my_action") }),
      });

      const entry = Type.map([
        [Type.atom("module"), Type.alias("MyModule")],
        [Type.atom("struct"), struct],
      ]);

      ComponentRegistry.entries = Type.map([[cid3, entry]]);

      const markDirtySpy = sinon.spy(RenderCache, "markDirty");

      try {
        ComponentRegistry.clearNextAction(cid3);

        sinon.assert.calledWith(markDirtySpy, cid3);
      } finally {
        markDirtySpy.restore();
      }
    });

    it("returns the same struct reference when next_action is already nil (identity fast path)", () => {
      const struct = Type.componentStruct();

      const entry = Type.map([
        [Type.atom("module"), Type.alias("MyModule")],
        [Type.atom("struct"), struct],
      ]);

      ComponentRegistry.entries = Type.map([[cid3, entry]]);

      ComponentRegistry.clearNextAction(cid3);

      assert.strictEqual(ComponentRegistry.getComponentStruct(cid3), struct);
    });
  });

  describe("getComponentEmittedContext()", () => {
    it("entry exists", () => {
      const result = ComponentRegistry.getComponentEmittedContext(cid2);
      assert.deepStrictEqual(result, emittedContext2);
    });

    it("entry doesn't exist", () => {
      const result = ComponentRegistry.getComponentEmittedContext(cid3);
      assert.isNull(result);
    });
  });

  describe("getComponentModule()", () => {
    it("entry exists", () => {
      const result = ComponentRegistry.getComponentModule(cid2);
      assert.equal(result, module2);
    });

    it("entry doesn't exist", () => {
      const result = ComponentRegistry.getComponentModule(cid3);
      assert.isNull(result);
    });
  });

  describe("getComponentState()", () => {
    it("entry exists", () => {
      const result = ComponentRegistry.getComponentState(cid2);
      assert.deepStrictEqual(result, state2);
    });

    it("entry doesn't exist", () => {
      const result = ComponentRegistry.getComponentState(cid3);
      assert.isNull(result);
    });
  });

  describe("getComponentStruct()", () => {
    it("entry exists", () => {
      const result = ComponentRegistry.getComponentStruct(cid2);
      assert.equal(result, struct2);
    });

    it("entry doesn't exist", () => {
      const result = ComponentRegistry.getComponentStruct(cid3);
      assert.isNull(result);
    });
  });

  describe("getEntry()", () => {
    it("entry exists", () => {
      const result = ComponentRegistry.getEntry(cid2);
      assert.equal(result, entry2);
    });

    it("entry doesn't exist", () => {
      const result = ComponentRegistry.getEntry(cid3);
      assert.isNull(result);
    });
  });

  describe("isCidRegistered()", () => {
    it("is registered", () => {
      assert.isTrue(ComponentRegistry.isCidRegistered(cid2));
    });

    it("is not registered", () => {
      assert.isFalse(ComponentRegistry.isCidRegistered(cid3));
    });
  });

  it("populate()", () => {
    ComponentRegistry.populate("dummyentries");
    assert.equal(ComponentRegistry.entries, "dummyentries");
  });

  it("putEntry()", () => {
    ComponentRegistry.putEntry(cid3, entry3);

    assert.deepStrictEqual(
      ComponentRegistry.entries,
      Type.map([
        [cid1, entry1],
        [cid2, entry2],
        [cid3, entry3],
      ]),
    );
  });

  it("putComponentStruct()", () => {
    initComponentRegistryEntry(cid4);

    const componentStruct = Type.componentStruct();
    ComponentRegistry.putComponentStruct(cid4, componentStruct);

    assert.equal(ComponentRegistry.getComponentStruct(cid4), componentStruct);
  });

  describe("putComponentStruct() identity fast path (#878)", () => {
    // #878's actual render-path payoff: an action that returns unchanged
    // state hands this the exact same struct reference already stored
    // (put/3's own identity fast path - see erlang/maps.mjs), so writing
    // it back and marking the cid dirty would be pure waste. This is what
    // turns "action ran but changed nothing" into zero re-render work,
    // for this cid and every ancestor whose descendant-dirtiness check
    // would otherwise trip on it.
    it("skips the write and does not mark the cid dirty when the struct is reference-identical to what is already stored", () => {
      initComponentRegistryEntry(cid4);

      const componentStruct = Type.componentStruct();
      ComponentRegistry.putComponentStruct(cid4, componentStruct);

      const entriesAfterFirstPut = ComponentRegistry.entries;

      const markDirtySpy = sinon.spy(RenderCache, "markDirty");

      try {
        ComponentRegistry.putComponentStruct(cid4, componentStruct);

        sinon.assert.notCalled(markDirtySpy);
      } finally {
        markDirtySpy.restore();
      }

      // Not just "still equal" - the whole entries trie must be untouched,
      // proving no path-copy happened either.
      assert.strictEqual(ComponentRegistry.entries, entriesAfterFirstPut);
    });

    it("still writes and marks the cid dirty when the struct is a distinct-but-equal object", () => {
      initComponentRegistryEntry(cid4);

      ComponentRegistry.putComponentStruct(cid4, Type.componentStruct());

      const markDirtySpy = sinon.spy(RenderCache, "markDirty");

      try {
        ComponentRegistry.putComponentStruct(cid4, Type.componentStruct());

        sinon.assert.calledWith(markDirtySpy, cid4);
      } finally {
        markDirtySpy.restore();
      }
    });
  });
});
