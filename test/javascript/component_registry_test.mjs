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

  // Bug #1002: executeAction() used to read a cid's struct, call the
  // action, and commit the result with no exclusion between separate
  // dispatches - a tight synchronous burst of dispatches against the same
  // cid all read the same pre-burst struct, and only the last commit
  // survived. runExclusive() is the fix: it's oblivious to what fn does: it
  // only cares about ordering fn calls against the same cid so a later one
  // never starts before an earlier one has settled.
  describe("runExclusive()", () => {
    // A test whose call never settles (an abandoned deferred) would
    // otherwise leave that cid's chain permanently occupied for every test
    // that runs after it - clear() resets #actionChains as well as
    // entries, so each test starts from a genuinely idle chain regardless
    // of what the previous one left in flight.
    beforeEach(() => {
      ComponentRegistry.clear();
      ComponentRegistry.entries = Type.map([
        [cid1, entry1],
        [cid2, entry2],
      ]);
    });

    function createDeferred() {
      let resolve, reject;

      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });

      return {promise, resolve, reject};
    }

    it("runs the callback synchronously and returns null when the cid has no action in flight", () => {
      let ran = false;

      const result = ComponentRegistry.runExclusive(cid1, () => {
        ran = true;
      });

      assert.isTrue(ran);
      assert.isNull(result);
    });

    it("propagates a synchronous throw from the callback synchronously when the cid is idle", () => {
      assert.throws(() => {
        ComponentRegistry.runExclusive(cid1, () => {
          throw new Error("boom");
        });
      }, "boom");
    });

    it("occupies the cid's chain while a returned promise is pending and releases it once the promise settles", async () => {
      const deferred = createDeferred();

      const gate = ComponentRegistry.runExclusive(cid1, () => deferred.promise);
      assert.instanceOf(gate, Promise);

      let secondRan = false;
      ComponentRegistry.runExclusive(cid1, () => {
        secondRan = true;
      });

      // Still occupied - the second call queued instead of running.
      assert.isFalse(secondRan);

      deferred.resolve();
      await gate;

      assert.isTrue(secondRan);
    });

    it("makes a queued call for a cid observe the committed effect of the call it queued behind", async () => {
      initComponentRegistryEntry(cid3);
      ComponentRegistry.putComponentStruct(cid3, Type.integer(0));

      const deferred = createDeferred();

      ComponentRegistry.runExclusive(cid3, () =>
        deferred.promise.then(() => {
          ComponentRegistry.putComponentStruct(cid3, Type.integer(1));
        }),
      );

      const secondGate = ComponentRegistry.runExclusive(cid3, () => {
        const current = ComponentRegistry.getComponentStruct(cid3);
        ComponentRegistry.putComponentStruct(
          cid3,
          Type.integer(Number(current.value) + 1),
        );
      });

      deferred.resolve();
      await secondGate;

      assert.deepStrictEqual(
        ComponentRegistry.getComponentStruct(cid3),
        Type.integer(2),
      );
    });

    it("runs three overlapping calls for the same cid in FIFO order", async () => {
      const order = [];
      const first = createDeferred();
      const second = createDeferred();

      const gate1 = ComponentRegistry.runExclusive(cid1, () =>
        first.promise.then(() => order.push(1)),
      );
      ComponentRegistry.runExclusive(cid1, () =>
        second.promise.then(() => order.push(2)),
      );
      const gate3 = ComponentRegistry.runExclusive(cid1, () => order.push(3));

      first.resolve();
      await gate1;
      second.resolve();
      await gate3;

      assert.deepEqual(order, [1, 2, 3]);
    });

    it("serializes a reentrant call made synchronously from inside another call's callback, for the same cid", async () => {
      // Matches a JS.exec loop that synchronously dispatches further
      // native events from inside an action's own body (bartblast/
      // hologram#1002's actual reported symptom - the reentrant dispatch
      // must queue exactly like an external one, not race the call it was
      // fired from inside of).
      initComponentRegistryEntry(cid3);
      ComponentRegistry.putComponentStruct(cid3, Type.integer(0));

      const outerDeferred = createDeferred();
      let innerGate;

      const outerGate = ComponentRegistry.runExclusive(cid3, () => {
        innerGate = ComponentRegistry.runExclusive(cid3, () => {
          const current = ComponentRegistry.getComponentStruct(cid3);
          ComponentRegistry.putComponentStruct(
            cid3,
            Type.integer(Number(current.value) + 1),
          );
        });

        return outerDeferred.promise.then(() => {
          ComponentRegistry.putComponentStruct(cid3, Type.integer(1));
        });
      });

      assert.instanceOf(innerGate, Promise);

      outerDeferred.resolve();
      await outerGate;
      await innerGate;

      assert.deepStrictEqual(
        ComponentRegistry.getComponentStruct(cid3),
        Type.integer(2),
      );
    });

    it("does not block a call for a different cid behind an in-flight call", () => {
      const deferred = createDeferred();
      ComponentRegistry.runExclusive(cid1, () => deferred.promise);

      let secondRan = false;
      ComponentRegistry.runExclusive(cid2, () => {
        secondRan = true;
      });

      assert.isTrue(secondRan);
    });

    it("does not wedge the chain when an in-flight promise rejects", async () => {
      const deferred = createDeferred();

      ComponentRegistry.runExclusive(cid1, () => deferred.promise);

      let thirdRan = false;
      const gate3 = ComponentRegistry.runExclusive(cid1, () => {
        thirdRan = true;
      });

      deferred.reject(new Error("rejected"));
      await gate3;

      assert.isTrue(thirdRan);
    });

    it("does not wedge the chain when a queued callback throws synchronously, and re-surfaces the throw as an uncaught error", async () => {
      // A queued callback can no longer throw synchronously out of
      // runExclusive - it's inside a microtask reaction by then. It must
      // still be reported, just one tick later, via queueMicrotask instead
      // of being silently swallowed by the gate's own rejection handler.
      // Stubbed rather than asserted against a real uncaught exception, so
      // this test can't crash the mocha process it runs in.
      const queueMicrotaskStub = sinon.stub(globalThis, "queueMicrotask");

      try {
        const first = createDeferred();
        const error = new Error("queued boom");

        ComponentRegistry.runExclusive(cid1, () => first.promise);
        ComponentRegistry.runExclusive(cid1, () => {
          throw error;
        });

        let thirdRan = false;
        const gate3 = ComponentRegistry.runExclusive(cid1, () => {
          thirdRan = true;
        });

        first.resolve();
        await gate3;

        assert.isTrue(thirdRan);
        sinon.assert.calledOnce(queueMicrotaskStub);
        assert.throws(() => queueMicrotaskStub.firstCall.args[0](), "queued boom");
      } finally {
        queueMicrotaskStub.restore();
      }
    });

    it("skips a queued callback whose cid is no longer registered", async () => {
      const deferred = createDeferred();

      ComponentRegistry.runExclusive(cid1, () => deferred.promise);

      let secondRan = false;
      const gate2 = ComponentRegistry.runExclusive(cid1, () => {
        secondRan = true;
      });

      // Simulates navigating away mid-flight: the registry is swapped out
      // from under the still-queued second call.
      ComponentRegistry.populate(Type.map());

      deferred.resolve();
      await gate2;

      assert.isFalse(secondRan);
    });

    it("skips a queued callback whose isStale check reports it stale", async () => {
      const deferred = createDeferred();

      ComponentRegistry.runExclusive(cid1, () => deferred.promise);

      let secondRan = false;
      const gate2 = ComponentRegistry.runExclusive(
        cid1,
        () => {
          secondRan = true;
        },
        () => true,
      );

      deferred.resolve();
      await gate2;

      assert.isFalse(secondRan);
    });

    it("runs a queued callback whose isStale check reports it still valid", async () => {
      const deferred = createDeferred();

      ComponentRegistry.runExclusive(cid1, () => deferred.promise);

      let secondRan = false;
      const gate2 = ComponentRegistry.runExclusive(
        cid1,
        () => {
          secondRan = true;
        },
        () => false,
      );

      deferred.resolve();
      await gate2;

      assert.isTrue(secondRan);
    });

    it("does not consult isStale on the synchronous path, since nothing was queued behind anything", () => {
      let isStaleCalled = false;
      let ran = false;

      const result = ComponentRegistry.runExclusive(
        cid1,
        () => {
          ran = true;
        },
        () => {
          isStaleCalled = true;
          return true;
        },
      );

      assert.isTrue(ran);
      assert.isNull(result);
      assert.isFalse(isStaleCalled);
    });

    it("clear() drops in-flight chain state so the next call for the same cid takes the synchronous path", () => {
      ComponentRegistry.runExclusive(cid1, () => createDeferred().promise);

      ComponentRegistry.clear();

      let ran = false;
      const result = ComponentRegistry.runExclusive(cid1, () => {
        ran = true;
      });

      assert.isTrue(ran);
      assert.isNull(result);
    });

    it("populate() drops in-flight chain state so the next call for the same cid takes the synchronous path", () => {
      ComponentRegistry.runExclusive(cid1, () => createDeferred().promise);

      ComponentRegistry.populate(Type.map());

      let ran = false;
      const result = ComponentRegistry.runExclusive(cid1, () => {
        ran = true;
      });

      assert.isTrue(ran);
      assert.isNull(result);
    });
  });
});
