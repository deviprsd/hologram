"use strict";

import {
  assert,
  defineRuntimeGlobals,
  registerWebApis,
  sinon,
  UUID_REGEX,
} from "./support/helpers.mjs";

import CallStack from "../../assets/js/erts/call_stack.mjs";
import Client from "../../assets/js/client.mjs";
import ComponentRegistry from "../../assets/js/component_registry.mjs";
import Config from "../../assets/js/config.mjs";
import EventListenerRegistry from "../../assets/js/event_listener_registry.mjs";
import EventListeners from "../../assets/js/event_listeners.mjs";
import GlobalRegistry from "../../assets/js/global_registry.mjs";
import Hologram from "../../assets/js/hologram.mjs";
import HologramBoxedError from "../../assets/js/errors/boxed_error.mjs";
import InitActionQueue from "../../assets/js/init_action_queue.mjs";
import Interpreter from "../../assets/js/interpreter.mjs";
import Renderer from "../../assets/js/renderer.mjs";
import Type from "../../assets/js/type.mjs";
import UncaughtErrorOverlay from "../../assets/js/uncaught_error_overlay.mjs";
import Vdom from "../../assets/js/vdom.mjs";

import {defineModule7Fixture} from "./support/fixtures/hologram/module_7.mjs";

defineRuntimeGlobals();
registerWebApis();
defineModule7Fixture();

const cid1 = Type.bitstring("my_component_1");
const module7 = Type.alias("Hologram.Test.Fixtures.Module7");

describe("Hologram", () => {
  // Bug #1002: a component's whole action/3 is compiled async if ANY clause
  // in it transitively reaches Task.await/1, even a sibling clause never
  // invoked by a given dispatch. Before this fix, executeAction() read a
  // target's struct and committed the result with no exclusion between
  // separate dispatches - a synchronous burst of dispatches against the
  // same target all read the same pre-burst struct, and only the last
  // commit survived. These tests exercise executeAction() directly (it was
  // previously only ever stubbed, see the "TODO: make private" comment on
  // it) via a hand-defined action/3 with both a sync-returning and an
  // async-returning clause, matching the two shapes real compiled code
  // produces per clause.
  describe("executeAction()", () => {
    const actionModuleName = "Hologram.Test.Fixtures.ActionRaceModule";
    const actionModule = Type.alias(actionModuleName);

    function buildStruct(count) {
      return Type.componentStruct({
        state: Type.map([[Type.atom("count"), Type.integer(count)]]),
      });
    }

    function buildAction(name, target) {
      return Type.actionStruct({
        name: Type.atom(name),
        params: Type.map(),
        target,
      });
    }

    function registerCid(cid, count) {
      ComponentRegistry.putEntry(
        cid,
        Type.map([
          [Type.atom("module"), actionModule],
          [Type.atom("struct"), buildStruct(count)],
        ]),
      );
    }

    function countOf(cid) {
      const state = Erlang_Maps["get/2"](
        Type.atom("state"),
        ComponentRegistry.getComponentStruct(cid),
      );

      return Number(Erlang_Maps["get/2"](Type.atom("count"), state).value);
    }

    beforeEach(() => {
      ComponentRegistry.clear();
      sinon.stub(Hologram, "render");

      // :throw - synchronous throw, no Task.await anywhere.
      // :bump - synchronous increment, no Task.await anywhere.
      // :bump_async - async-returning clause (as if this were the sibling
      // clause of :bump in a component whose whole action/3 got compiled
      // async because of an unrelated Task.await elsewhere), but its body
      // does the same synchronous increment - no real await inside it.
      Interpreter.defineElixirFunction(actionModuleName, "action", 3, "public", [
        {
          params: (_context) => [
            Type.atom("throw"),
            Type.matchPlaceholder(),
            Type.variablePattern("struct"),
          ],
          guards: [],
          body: (_context) => {
            throw new Error("boom");
          },
        },
        {
          params: (_context) => [
            Type.atom("bump"),
            Type.matchPlaceholder(),
            Type.variablePattern("struct"),
          ],
          guards: [],
          body: (context) => {
            const state = Erlang_Maps["get/2"](
              Type.atom("state"),
              context.vars.struct,
            );

            const count = Erlang_Maps["get/2"](Type.atom("count"), state);

            const newState = Erlang_Maps["put/3"](
              Type.atom("count"),
              Type.integer(Number(count.value) + 1),
              state,
            );

            return Erlang_Maps["put/3"](
              Type.atom("state"),
              newState,
              context.vars.struct,
            );
          },
        },
        {
          params: (_context) => [
            Type.atom("bump_async"),
            Type.matchPlaceholder(),
            Type.variablePattern("struct"),
          ],
          guards: [],
          body: async (context) => {
            const state = Erlang_Maps["get/2"](
              Type.atom("state"),
              context.vars.struct,
            );

            const count = Erlang_Maps["get/2"](Type.atom("count"), state);

            const newState = Erlang_Maps["put/3"](
              Type.atom("count"),
              Type.integer(Number(count.value) + 1),
              state,
            );

            return Erlang_Maps["put/3"](
              Type.atom("state"),
              newState,
              context.vars.struct,
            );
          },
        },
      ]);
    });

    afterEach(() => sinon.restore());

    it("propagates a synchronous action error synchronously to the caller", () => {
      registerCid(cid1, 0);

      assert.throws(() => {
        Hologram.executeAction(buildAction("throw", cid1));
      }, "boom");
    });

    it("does not wrap a synchronous action's result in a Promise when the target is idle", () => {
      registerCid(cid1, 0);

      const result = Hologram.executeAction(buildAction("bump", cid1));

      assert.isNull(result);
      assert.equal(countOf(cid1), 1);
    });

    it("makes a second dispatch to the same target observe the first dispatch's committed struct", async () => {
      registerCid(cid1, 0);

      const gate1 = Hologram.executeAction(buildAction("bump_async", cid1));
      assert.instanceOf(gate1, Promise);

      const gate2 = Hologram.executeAction(buildAction("bump_async", cid1));
      assert.instanceOf(gate2, Promise);

      await gate1;
      await gate2;

      assert.equal(countOf(cid1), 2);
    });

    it("does not delay a dispatch to a different target behind an in-flight one", () => {
      registerCid(cid1, 0);

      const cid2 = Type.bitstring("my_component_2");
      registerCid(cid2, 0);

      Hologram.executeAction(buildAction("bump_async", cid1));

      const result = Hologram.executeAction(buildAction("bump", cid2));

      assert.isNull(result);
      assert.equal(countOf(cid2), 1);
    });

    it("no-ops instead of crashing when the target's cid was deregistered before dispatch (issue #18)", () => {
      registerCid(cid1, 0);

      // Nothing in the runtime ever removes a single entry - the only way a
      // previously-registered cid stops being registered is a full-registry
      // swap, which only happens on navigation (ComponentRegistry.populate()).
      // A stale native-event listener or debounced timer armed before that
      // swap can still fire afterwards, dispatching against a cid the fresh
      // registry never heard of.
      ComponentRegistry.populate(Type.map());

      assert.doesNotThrow(() => {
        const result = Hologram.executeAction(buildAction("bump", cid1));
        assert.isNull(result);
      });
    });
  });

  describe("executeLoadPrefetchedPageAction()", () => {
    let eventTargetNode, loadNewPageStub;

    const payload = {type: "page"};

    const loadPrefetchedPageAction = Type.actionStruct({
      name: Type.atom("__load_prefetched_page__"),
      params: Type.map([[Type.atom("to"), module7]]),
      target: cid1,
    });

    const pagePath = "/hologram-test-fixtures-module7";

    beforeEach(() => {
      loadNewPageStub = sinon
        .stub(Hologram, "loadNewPage")
        .callsFake((_pagePath, _payload) => null);

      eventTargetNode = {id: "dummy_event_target_node"};
    });

    afterEach(() => Hologram.loadNewPage.restore());

    it("adds a Hologram ID to an event target DOM node that doesn't have one", () => {
      Hologram.executeLoadPrefetchedPageAction(
        loadPrefetchedPageAction,
        eventTargetNode,
      );

      assert.match(eventTargetNode.__hologramId__, UUID_REGEX);
    });

    it("doesn't add a Hologram ID to an event target DOM node that already has one", () => {
      eventTargetNode.__hologramId__ = "dummy_hologram_id";

      Hologram.executeLoadPrefetchedPageAction(
        loadPrefetchedPageAction,
        eventTargetNode,
      );

      assert.equal(eventTargetNode.__hologramId__, "dummy_hologram_id");
    });

    it("confirms navigate if page HTML hasn't been fetched yet", () => {
      eventTargetNode = {__hologramId__: "dummy_hologram_id"};
      const mapKey = "dummy_hologram_id:/hologram-test-fixtures-module7";

      Hologram.prefetchedPages = new Map([
        [
          mapKey,
          {
            payload: null,
            isNavigateConfirmed: false,
            pagePath: pagePath,
            timestamp: Date.now(),
          },
        ],
      ]);

      Hologram.executeLoadPrefetchedPageAction(
        loadPrefetchedPageAction,
        eventTargetNode,
      );

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 1);
      assert.isTrue(Hologram.prefetchedPages.has(mapKey));

      const mapValue = Hologram.prefetchedPages.get(mapKey);

      assert.deepStrictEqual(mapValue, {
        payload: null,
        isNavigateConfirmed: true,
        pagePath: pagePath,
        timestamp: mapValue.timestamp,
      });

      sinon.assert.notCalled(loadNewPageStub);
    });

    it("loads page if page HTML has been already fetched", () => {
      eventTargetNode = {__hologramId__: "dummy_hologram_id"};
      const mapKey = "dummy_hologram_id:/hologram-test-fixtures-module7";

      Hologram.prefetchedPages = new Map([
        [
          mapKey,
          {
            payload: payload,
            isNavigateConfirmed: false,
            pagePath: pagePath,
            timestamp: Date.now(),
          },
        ],
      ]);

      Hologram.executeLoadPrefetchedPageAction(
        loadPrefetchedPageAction,
        eventTargetNode,
      );

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 0);

      sinon.assert.calledOnceWithExactly(loadNewPageStub, pagePath, payload);
    });

    // Dropping the entry instead would leave the link dead: the click looks the target up here,
    // and an entry that is not there does nothing at all.
    it("hands the target to the browser when the prefetch found no page", () => {
      const leaveAppStub = sinon.stub(Hologram, "leaveApp");

      eventTargetNode = {__hologramId__: "dummy_hologram_id"};
      const mapKey = "dummy_hologram_id:/hologram-test-fixtures-module7";

      Hologram.prefetchedPages = new Map([
        [
          mapKey,
          {
            isNavigateConfirmed: false,
            isPage: false,
            pagePath: pagePath,
            payload: null,
            timestamp: Date.now(),
          },
        ],
      ]);

      Hologram.executeLoadPrefetchedPageAction(
        loadPrefetchedPageAction,
        eventTargetNode,
      );

      assert.equal(Hologram.prefetchedPages.size, 0);

      sinon.assert.calledOnceWithExactly(leaveAppStub, pagePath);
      sinon.assert.notCalled(loadNewPageStub);

      leaveAppStub.restore();
    });

    it("is a no-op if there is no prefeteched pages map entry for the given map key", () => {
      Hologram.prefetchedPages = new Map();

      Hologram.executeLoadPrefetchedPageAction(
        loadPrefetchedPageAction,
        eventTargetNode,
      );

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 0);

      sinon.assert.notCalled(loadNewPageStub);
    });
  });

  describe("executePrefetchPageAction()", () => {
    let clientFetchPageStub,
      eventTargetNode,
      handlePrefetchPageSuccessStub,
      successCallbacks;

    const pagePath = "/hologram-test-fixtures-module7";

    const prefetchPageAction = Type.actionStruct({
      name: Type.atom("__prefetch_page__"),
      params: Type.map([[Type.atom("to"), module7]]),
      target: cid1,
    });

    const resp = "dummy_resp";

    beforeEach(() => {
      successCallbacks = [];

      clientFetchPageStub = sinon
        .stub(Client, "fetchPage")
        .callsFake((_toParam, successCallback) => {
          successCallbacks.push(successCallback);
        });

      handlePrefetchPageSuccessStub = sinon
        .stub(Hologram, "handlePrefetchPageSuccess")
        .callsFake((_mapKey, _resp) => null);

      eventTargetNode = {id: "dummy_event_target_node"};
    });

    afterEach(() => {
      Client.fetchPage.restore();
      Hologram.handlePrefetchPageSuccess.restore();
    });

    it("adds a Hologram ID to an event target DOM node that doesn't have one", () => {
      Hologram.executePrefetchPageAction(prefetchPageAction, eventTargetNode);
      assert.match(eventTargetNode.__hologramId__, UUID_REGEX);
    });

    it("doesn't add a Hologram ID to an event target DOM node that already has one", () => {
      eventTargetNode.__hologramId__ = "dummy_hologram_id";

      Hologram.executePrefetchPageAction(prefetchPageAction, eventTargetNode);

      assert.equal(eventTargetNode.__hologramId__, "dummy_hologram_id");
    });

    it("prefetches the page if there is no previous prefetch in progress", () => {
      Hologram.prefetchedPages = new Map();

      Hologram.executePrefetchPageAction(prefetchPageAction, eventTargetNode);

      const mapKey = `${eventTargetNode.__hologramId__}:/hologram-test-fixtures-module7`;

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 1);
      assert.isTrue(Hologram.prefetchedPages.has(mapKey));

      const mapValue = Hologram.prefetchedPages.get(mapKey);

      assert.deepStrictEqual(mapValue, {
        isNavigateConfirmed: false,
        isPage: true,
        pagePath: pagePath,
        payload: null,
        timestamp: mapValue.timestamp,
      });

      assert.isAtMost(Math.abs(Date.now() - mapValue.timestamp), 100);

      sinon.assert.calledOnceWithExactly(
        clientFetchPageStub,
        module7,
        successCallbacks[0],
        sinon.match.func,
      );

      assert.equal(successCallbacks.length, 1);

      successCallbacks[0](resp);

      sinon.assert.calledOnceWithExactly(
        handlePrefetchPageSuccessStub,
        mapKey,
        resp,
      );
    });

    it("prefetches the page if the previous prefetch has timed out", () => {
      eventTargetNode = {__hologramId__: "dummy_hologram_id"};
      const mapKey = "dummy_hologram_id:/hologram-test-fixtures-module7";

      Hologram.prefetchedPages = new Map([
        [
          mapKey,
          {
            dummyKey: "dummy_value",
            timestamp: Date.now() - Config.fetchPageTimeoutMs - 1,
          },
        ],
      ]);

      Hologram.executePrefetchPageAction(prefetchPageAction, eventTargetNode);

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 1);
      assert.isTrue(Hologram.prefetchedPages.has(mapKey));

      const mapValue = Hologram.prefetchedPages.get(mapKey);

      assert.deepStrictEqual(Hologram.prefetchedPages.get(mapKey), {
        isNavigateConfirmed: false,
        isPage: true,
        pagePath: pagePath,
        payload: null,
        timestamp: mapValue.timestamp,
      });

      assert.isAtMost(Math.abs(Date.now() - mapValue.timestamp), 100);

      sinon.assert.calledOnceWithExactly(
        clientFetchPageStub,
        module7,
        successCallbacks[0],
        sinon.match.func,
      );

      assert.equal(successCallbacks.length, 1);

      successCallbacks[0](resp);

      sinon.assert.calledOnceWithExactly(
        handlePrefetchPageSuccessStub,
        mapKey,
        resp,
      );
    });

    it("doesn't prefetch the page if the previous prefetch is in progress and hasn't timed out", () => {
      eventTargetNode = {__hologramId__: "dummy_hologram_id"};
      const mapKey = "dummy_hologram_id:/hologram-test-fixtures-module7";

      const mapValue = {
        dummyKey: "dummy_value",
        timestamp: Date.now(),
      };

      Hologram.prefetchedPages = new Map([[mapKey, mapValue]]);

      Hologram.executePrefetchPageAction(prefetchPageAction, eventTargetNode);

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 1);
      assert.isTrue(Hologram.prefetchedPages.has(mapKey));
      assert.equal(Hologram.prefetchedPages.get(mapKey), mapValue);

      sinon.assert.notCalled(clientFetchPageStub);
      sinon.assert.notCalled(handlePrefetchPageSuccessStub);
    });
  });

  describe("handleUiEvent()", () => {
    let executeActionStub,
      clientSendCommandStub,
      executeLoadPrefetchedPageActionStub,
      executePrefetchPageActionStub,
      scheduleActionStub;

    const actionSpecDom = Type.keywordList([
      [Type.atom("text"), Type.bitstring("my_action")],
    ]);

    // Example: $click={nil}
    const disabledSpecDom = Type.keywordList([
      [Type.atom("expression"), Type.tuple([Type.nil()])],
    ]);

    const defaultTarget = cid1;
    const eventType = "click";

    const notIgnoredEvent = {
      altKey: false,
      clientX: 10,
      clientY: 20,
      ctrlKey: false,
      metaKey: false,
      movementX: 5,
      movementY: 15,
      offsetX: 30,
      offsetY: 40,
      pageX: 1,
      pageY: 2,
      pointerType: "mouse",
      screenX: 100,
      screenY: 200,
      shiftKey: false,
      preventDefault: () => null,
      target: {id: "dummy_node"},
    };

    beforeEach(() => {
      clientSendCommandStub = sinon
        .stub(Client, "sendCommand")
        .callsFake((_command) => null);

      executeActionStub = sinon
        .stub(Hologram, "executeAction")
        .callsFake((_action) => null);

      executeLoadPrefetchedPageActionStub = sinon
        .stub(Hologram, "executeLoadPrefetchedPageAction")
        .callsFake((_action, _eventTargetNode) => null);

      executePrefetchPageActionStub = sinon
        .stub(Hologram, "executePrefetchPageAction")
        .callsFake((_action, _eventTargetNode) => null);

      scheduleActionStub = sinon
        .stub(Hologram, "scheduleAction")
        .callsFake((_action) => null);
    });

    afterEach(() => {
      Client.sendCommand.restore();
      Hologram.executeAction.restore();
      Hologram.executeLoadPrefetchedPageAction.restore();
      Hologram.executePrefetchPageAction.restore();
      Hologram.scheduleAction.restore();
    });

    it("event is ignored", () => {
      const ignoredEvent = {
        clientX: 10,
        clientY: 20,
        movementX: 5,
        movementY: 15,
        offsetX: 30,
        offsetY: 40,
        pageX: 1,
        pageY: 2,
        pointerType: "mouse",
        screenX: 100,
        screenY: 200,
        ctrlKey: true,
        preventDefault: () => null,
      };

      Hologram.handleUiEvent(
        ignoredEvent,
        eventType,
        actionSpecDom,
        defaultTarget,
      );

      sinon.assert.notCalled(clientSendCommandStub);
      sinon.assert.notCalled(executeActionStub);
      sinon.assert.notCalled(executeLoadPrefetchedPageActionStub);
      sinon.assert.notCalled(executePrefetchPageActionStub);
      sinon.assert.notCalled(scheduleActionStub);
    });

    it("regular action without delay", () => {
      const dispatch = Hologram.handleUiEvent(
        notIgnoredEvent,
        eventType,
        actionSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(clientSendCommandStub);
      sinon.assert.notCalled(executeLoadPrefetchedPageActionStub);
      sinon.assert.notCalled(executePrefetchPageActionStub);

      const expectedAction = Type.actionStruct({
        name: Type.atom("my_action"),
        params: Type.map([
          [
            Type.atom("event"),
            Type.map([
              [Type.atom("alt_key"), Type.boolean(false)],
              [Type.atom("client_x"), Type.float(10)],
              [Type.atom("client_y"), Type.float(20)],
              [Type.atom("ctrl_key"), Type.boolean(false)],
              [Type.atom("meta_key"), Type.boolean(false)],
              [Type.atom("movement_x"), Type.float(5)],
              [Type.atom("movement_y"), Type.float(15)],
              [Type.atom("offset_x"), Type.float(30)],
              [Type.atom("offset_y"), Type.float(40)],
              [Type.atom("page_x"), Type.float(1)],
              [Type.atom("page_y"), Type.float(2)],
              [Type.atom("pointer_type"), Type.atom("mouse")],
              [Type.atom("screen_x"), Type.float(100)],
              [Type.atom("screen_y"), Type.float(200)],
              [Type.atom("shift_key"), Type.boolean(false)],
            ]),
          ],
        ]),
        target: defaultTarget,
      });

      sinon.assert.calledOnceWithExactly(executeActionStub, expectedAction);
      sinon.assert.notCalled(scheduleActionStub);
    });

    it("regular action with delay", () => {
      const delayedActionSpecDom = Type.keywordList([
        [
          Type.atom("expression"),
          Type.tuple([
            Type.keywordList([
              [Type.atom("action"), Type.atom("my_delayed_action")],
              [Type.atom("delay"), Type.integer(500)],
            ]),
          ]),
        ],
      ]);

      const dispatch = Hologram.handleUiEvent(
        notIgnoredEvent,
        eventType,
        delayedActionSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(clientSendCommandStub);
      sinon.assert.notCalled(executeLoadPrefetchedPageActionStub);
      sinon.assert.notCalled(executePrefetchPageActionStub);

      const expectedAction = Type.actionStruct({
        name: Type.atom("my_delayed_action"),
        params: Type.map([
          [
            Type.atom("event"),
            Type.map([
              [Type.atom("alt_key"), Type.boolean(false)],
              [Type.atom("client_x"), Type.float(10)],
              [Type.atom("client_y"), Type.float(20)],
              [Type.atom("ctrl_key"), Type.boolean(false)],
              [Type.atom("meta_key"), Type.boolean(false)],
              [Type.atom("movement_x"), Type.float(5)],
              [Type.atom("movement_y"), Type.float(15)],
              [Type.atom("offset_x"), Type.float(30)],
              [Type.atom("offset_y"), Type.float(40)],
              [Type.atom("page_x"), Type.float(1)],
              [Type.atom("page_y"), Type.float(2)],
              [Type.atom("pointer_type"), Type.atom("mouse")],
              [Type.atom("screen_x"), Type.float(100)],
              [Type.atom("screen_y"), Type.float(200)],
              [Type.atom("shift_key"), Type.boolean(false)],
            ]),
          ],
        ]),
        target: defaultTarget,
        delay: Type.integer(500),
      });

      sinon.assert.calledOnceWithExactly(scheduleActionStub, expectedAction);
      sinon.assert.notCalled(executeActionStub);
    });

    it("navigate to prefetched page action", () => {
      // Spec DOM: [expression: {[action: :__load_prefetched_page__, params: %{to: MyPage}]}],
      // which is equivalent to [{:expression, {[{:action, :__load_prefetched_page__}, {:params, %{to: MyPage}}]}}]
      const actionSpecDom = Type.keywordList([
        [
          Type.atom("expression"),
          Type.tuple([
            Type.keywordList([
              [Type.atom("action"), Type.atom("__load_prefetched_page__")],
              [
                Type.atom("params"),
                Type.map([[Type.atom("to"), Type.alias("MyPage")]]),
              ],
            ]),
          ]),
        ],
      ]);

      const dispatch = Hologram.handleUiEvent(
        notIgnoredEvent,
        eventType,
        actionSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(clientSendCommandStub);
      sinon.assert.notCalled(executeActionStub);
      sinon.assert.notCalled(executePrefetchPageActionStub);
      sinon.assert.notCalled(scheduleActionStub);

      const expectedAction = Type.actionStruct({
        name: Type.atom("__load_prefetched_page__"),
        params: Type.map([
          [Type.atom("to"), Type.alias("MyPage")],
          [
            Type.atom("event"),
            Type.map([
              [Type.atom("alt_key"), Type.boolean(false)],
              [Type.atom("client_x"), Type.float(10)],
              [Type.atom("client_y"), Type.float(20)],
              [Type.atom("ctrl_key"), Type.boolean(false)],
              [Type.atom("meta_key"), Type.boolean(false)],
              [Type.atom("movement_x"), Type.float(5)],
              [Type.atom("movement_y"), Type.float(15)],
              [Type.atom("offset_x"), Type.float(30)],
              [Type.atom("offset_y"), Type.float(40)],
              [Type.atom("page_x"), Type.float(1)],
              [Type.atom("page_y"), Type.float(2)],
              [Type.atom("pointer_type"), Type.atom("mouse")],
              [Type.atom("screen_x"), Type.float(100)],
              [Type.atom("screen_y"), Type.float(200)],
              [Type.atom("shift_key"), Type.boolean(false)],
            ]),
          ],
        ]),
        target: defaultTarget,
      });

      sinon.assert.calledOnceWithExactly(
        executeLoadPrefetchedPageActionStub,
        expectedAction,
        notIgnoredEvent.target,
      );
    });

    it("prefetch page action", () => {
      // Spec DOM: [expression: {[action: :__prefetch_page__, params: %{to: MyPage}]}],
      // which is equivalent to [{:expression, {[{:action, :__prefetch_page__}, {:params, %{to: MyPage}}]}}]
      const actionSpecDom = Type.keywordList([
        [
          Type.atom("expression"),
          Type.tuple([
            Type.keywordList([
              [Type.atom("action"), Type.atom("__prefetch_page__")],
              [
                Type.atom("params"),
                Type.map([[Type.atom("to"), Type.alias("MyPage")]]),
              ],
            ]),
          ]),
        ],
      ]);

      const dispatch = Hologram.handleUiEvent(
        notIgnoredEvent,
        eventType,
        actionSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(clientSendCommandStub);
      sinon.assert.notCalled(executeActionStub);
      sinon.assert.notCalled(executeLoadPrefetchedPageActionStub);
      sinon.assert.notCalled(scheduleActionStub);

      const expectedAction = Type.actionStruct({
        name: Type.atom("__prefetch_page__"),
        params: Type.map([
          [Type.atom("to"), Type.alias("MyPage")],
          [
            Type.atom("event"),
            Type.map([
              [Type.atom("alt_key"), Type.boolean(false)],
              [Type.atom("client_x"), Type.float(10)],
              [Type.atom("client_y"), Type.float(20)],
              [Type.atom("ctrl_key"), Type.boolean(false)],
              [Type.atom("meta_key"), Type.boolean(false)],
              [Type.atom("movement_x"), Type.float(5)],
              [Type.atom("movement_y"), Type.float(15)],
              [Type.atom("offset_x"), Type.float(30)],
              [Type.atom("offset_y"), Type.float(40)],
              [Type.atom("page_x"), Type.float(1)],
              [Type.atom("page_y"), Type.float(2)],
              [Type.atom("pointer_type"), Type.atom("mouse")],
              [Type.atom("screen_x"), Type.float(100)],
              [Type.atom("screen_y"), Type.float(200)],
              [Type.atom("shift_key"), Type.boolean(false)],
            ]),
          ],
        ]),
        target: defaultTarget,
      });

      sinon.assert.calledOnceWithExactly(
        executePrefetchPageActionStub,
        expectedAction,
        notIgnoredEvent.target,
      );
    });

    it("command", () => {
      // Example: $click={command: :my_command}
      // Spec DOM: [expression: {[command: :my_command]}],
      // which is equivalent to [{:expression, {[{:command, :my_command}]}}]
      const commandSpecDom = Type.keywordList([
        [
          Type.atom("expression"),
          Type.tuple([
            Type.keywordList([[Type.atom("command"), Type.atom("my_command")]]),
          ]),
        ],
      ]);

      const dispatch = Hologram.handleUiEvent(
        notIgnoredEvent,
        eventType,
        commandSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(executeActionStub);
      sinon.assert.notCalled(executeLoadPrefetchedPageActionStub);
      sinon.assert.notCalled(executePrefetchPageActionStub);
      sinon.assert.notCalled(scheduleActionStub);

      const expectedCommand = Type.commandStruct({
        name: Type.atom("my_command"),
        params: Type.map([
          [
            Type.atom("event"),
            Type.map([
              [Type.atom("alt_key"), Type.boolean(false)],
              [Type.atom("client_x"), Type.float(10)],
              [Type.atom("client_y"), Type.float(20)],
              [Type.atom("ctrl_key"), Type.boolean(false)],
              [Type.atom("meta_key"), Type.boolean(false)],
              [Type.atom("movement_x"), Type.float(5)],
              [Type.atom("movement_y"), Type.float(15)],
              [Type.atom("offset_x"), Type.float(30)],
              [Type.atom("offset_y"), Type.float(40)],
              [Type.atom("page_x"), Type.float(1)],
              [Type.atom("page_y"), Type.float(2)],
              [Type.atom("pointer_type"), Type.atom("mouse")],
              [Type.atom("screen_x"), Type.float(100)],
              [Type.atom("screen_y"), Type.float(200)],
              [Type.atom("shift_key"), Type.boolean(false)],
            ]),
          ],
        ]),
        target: defaultTarget,
      });

      sinon.assert.calledOnceWithExactly(
        clientSendCommandStub,
        expectedCommand,
      );
    });

    it("does not prevent default when isDefaultAllowed is true", () => {
      // KeyboardEvent.isDefaultAllowed is true
      const preventDefault = sinon.spy();

      const keyboardEvent = {
        altKey: false,
        code: "Enter",
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        repeat: false,
        shiftKey: false,
        preventDefault,
        target: {id: "dummy_node"},
      };

      const dispatch = Hologram.handleUiEvent(
        keyboardEvent,
        "keydown",
        actionSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(preventDefault);
      sinon.assert.calledOnce(executeActionStub);
    });

    it("prevents default when isDefaultAllowed is false", () => {
      // SubmitEvent.isDefaultAllowed is false, so a native form submit is prevented by default

      const preventDefault = sinon.spy();

      const submitEvent = {
        target: document.createElement("form"),
        preventDefault,
      };

      Hologram.handleUiEvent(
        submitEvent,
        "submit",
        actionSpecDom,
        defaultTarget,
      );

      sinon.assert.calledOnce(preventDefault);
    });

    it("allows the default when allowDefault is set", () => {
      // The binding's allow_default modifier opts out of the framework preventDefault, even for
      // an isDefaultAllowed: false event like submit.

      const preventDefault = sinon.spy();

      const submitEvent = {
        target: document.createElement("form"),
        preventDefault,
      };

      const dispatch = Hologram.handleUiEvent(
        submitEvent,
        "submit",
        actionSpecDom,
        defaultTarget,
        true,
      );

      dispatch();

      sinon.assert.notCalled(preventDefault);
      sinon.assert.calledOnce(executeActionStub);
    });

    it("prevents the default when forcePreventDefault is set", () => {
      // The binding's prevent_default modifier forces the framework preventDefault, even for an
      // isDefaultAllowed: true event like keydown.

      const preventDefault = sinon.spy();

      const keyboardEvent = {
        altKey: false,
        code: "Enter",
        ctrlKey: false,
        key: "Enter",
        metaKey: false,
        repeat: false,
        shiftKey: false,
        preventDefault,
        target: {id: "dummy_node"},
      };

      const dispatch = Hologram.handleUiEvent(
        keyboardEvent,
        "keydown",
        actionSpecDom,
        defaultTarget,
        false,
        false,
        true,
      );

      dispatch();

      sinon.assert.calledOnce(preventDefault);
      sinon.assert.calledOnce(executeActionStub);
    });

    it("does not stop propagation by default", () => {
      const stopPropagation = sinon.spy();

      const submitEvent = {
        target: document.createElement("form"),
        preventDefault: () => null,
        stopPropagation,
      };

      const dispatch = Hologram.handleUiEvent(
        submitEvent,
        "submit",
        actionSpecDom,
        defaultTarget,
      );

      dispatch();

      sinon.assert.notCalled(stopPropagation);
      sinon.assert.calledOnce(executeActionStub);
    });

    it("stops propagation when stopPropagation is set", () => {
      // The binding's stop_propagation modifier stops the event from bubbling past the bound
      // element while the action still dispatches.

      const stopPropagation = sinon.spy();

      const submitEvent = {
        target: document.createElement("form"),
        preventDefault: () => null,
        stopPropagation,
      };

      const dispatch = Hologram.handleUiEvent(
        submitEvent,
        "submit",
        actionSpecDom,
        defaultTarget,
        false,
        true,
      );

      dispatch();

      sinon.assert.calledOnce(stopPropagation);
      sinon.assert.calledOnce(executeActionStub);
    });

    it("does not stop propagation when the event is ignored", () => {
      // ClickEvent ignores a Ctrl+click, so the event edge work doesn't run for it.

      const stopPropagation = sinon.spy();

      const ignoredEvent = {
        clientX: 10,
        clientY: 20,
        movementX: 5,
        movementY: 15,
        offsetX: 30,
        offsetY: 40,
        pageX: 1,
        pageY: 2,
        pointerType: "mouse",
        screenX: 100,
        screenY: 200,
        ctrlKey: true,
        preventDefault: () => null,
        stopPropagation,
      };

      Hologram.handleUiEvent(
        ignoredEvent,
        eventType,
        actionSpecDom,
        defaultTarget,
        false,
        true,
      );

      sinon.assert.notCalled(stopPropagation);
    });

    it("tolerates an event payload without a stopPropagation method", () => {
      // A resize binding's ResizeObserverEntry is not a DOM event and has no stopPropagation
      // method, so the call is skipped instead of crashing.

      const resizeObserverEntry = {
        target: {},
        borderBoxSize: [{blockSize: 10, inlineSize: 20}],
        contentBoxSize: [{blockSize: 8, inlineSize: 18}],
        devicePixelContentBoxSize: [{blockSize: 20, inlineSize: 40}],
      };

      const dispatch = Hologram.handleUiEvent(
        resizeObserverEntry,
        "resize",
        actionSpecDom,
        defaultTarget,
        false,
        true,
      );

      dispatch();

      sinon.assert.calledOnce(executeActionStub);
    });

    it("tolerates an event payload without a preventDefault method", () => {
      // A resize binding's ResizeObserverEntry is not a DOM event and has no preventDefault
      // method, so a forced preventDefault is skipped instead of crashing.

      const resizeObserverEntry = {
        target: {},
        borderBoxSize: [{blockSize: 10, inlineSize: 20}],
        contentBoxSize: [{blockSize: 8, inlineSize: 18}],
        devicePixelContentBoxSize: [{blockSize: 20, inlineSize: 40}],
      };

      const dispatch = Hologram.handleUiEvent(
        resizeObserverEntry,
        "resize",
        actionSpecDom,
        defaultTarget,
        false,
        false,
        true,
      );

      dispatch();

      sinon.assert.calledOnce(executeActionStub);
    });

    it("returns null for a disabled binding", () => {
      const result = Hologram.handleUiEvent(
        notIgnoredEvent,
        eventType,
        disabledSpecDom,
        defaultTarget,
      );

      assert.isNull(result);

      sinon.assert.notCalled(clientSendCommandStub);
      sinon.assert.notCalled(executeActionStub);
      sinon.assert.notCalled(executeLoadPrefetchedPageActionStub);
      sinon.assert.notCalled(executePrefetchPageActionStub);
      sinon.assert.notCalled(scheduleActionStub);
    });

    it("does not prevent default for a disabled binding", () => {
      // SubmitEvent.isDefaultAllowed is false, so an enabled binding would prevent the default.

      const preventDefault = sinon.spy();

      const submitEvent = {
        target: document.createElement("form"),
        preventDefault,
      };

      Hologram.handleUiEvent(
        submitEvent,
        "submit",
        disabledSpecDom,
        defaultTarget,
      );

      sinon.assert.notCalled(preventDefault);
    });

    it("does not stop propagation for a disabled binding when stopPropagation is set", () => {
      const stopPropagation = sinon.spy();

      const submitEvent = {
        target: document.createElement("form"),
        preventDefault: () => null,
        stopPropagation,
      };

      Hologram.handleUiEvent(
        submitEvent,
        "submit",
        disabledSpecDom,
        defaultTarget,
        false,
        true,
      );

      sinon.assert.notCalled(stopPropagation);
    });

    it("dispatches a reach event with an empty payload", () => {
      const dispatch = Hologram.handleUiEvent(
        {target: {id: "dummy_node"}},
        "reach_bottom",
        actionSpecDom,
        defaultTarget,
      );

      dispatch();

      const expectedAction = Type.actionStruct({
        name: Type.atom("my_action"),
        params: Type.map([[Type.atom("event"), Type.map()]]),
        target: defaultTarget,
      });

      sinon.assert.calledOnceWithExactly(executeActionStub, expectedAction);
    });
  });

  describe("handlePrefetchPageNotPage()", () => {
    let leaveAppStub;

    beforeEach(() => {
      leaveAppStub = sinon.stub(Hologram, "leaveApp");
    });

    afterEach(() => leaveAppStub.restore());

    it("leaves the app when navigate has already been confirmed", () => {
      Hologram.prefetchedPages = new Map([
        [
          "dummy_map_key",
          {
            isNavigateConfirmed: true,
            isPage: true,
            pagePath: "/my-page-path",
            payload: null,
            timestamp: Date.now(),
          },
        ],
      ]);

      Hologram.handlePrefetchPageNotPage("dummy_map_key");

      assert.equal(Hologram.prefetchedPages.size, 0);
      sinon.assert.calledOnceWithExactly(leaveAppStub, "/my-page-path");
    });

    // Before the click, the answer is only remembered: leaving the app on hover would take the
    // user somewhere they have not asked to go.
    it("marks the entry when navigate hasn't been confirmed", () => {
      const mapKey = "dummy_map_key";

      Hologram.prefetchedPages = new Map([
        [
          mapKey,
          {
            isNavigateConfirmed: false,
            isPage: true,
            pagePath: "/my-page-path",
            payload: null,
            timestamp: Date.now(),
          },
        ],
      ]);

      Hologram.handlePrefetchPageNotPage(mapKey);

      assert.equal(Hologram.prefetchedPages.size, 1);
      assert.isFalse(Hologram.prefetchedPages.get(mapKey).isPage);
      sinon.assert.notCalled(leaveAppStub);
    });

    it("no prefetchedPages map entry", () => {
      Hologram.prefetchedPages = new Map();

      Hologram.handlePrefetchPageNotPage("dummy_map_key");

      assert.equal(Hologram.prefetchedPages.size, 0);
      sinon.assert.notCalled(leaveAppStub);
    });
  });

  describe("handlePrefetchPageSuccess()", () => {
    let loadNewPageStub;

    beforeEach(() => {
      loadNewPageStub = sinon
        .stub(Hologram, "loadNewPage")
        .callsFake((_pagePath, _payload) => null);
    });

    afterEach(() => Hologram.loadNewPage.restore());

    it("no prefetchedPages map entry", () => {
      Hologram.prefetchedPages = new Map();

      Hologram.handlePrefetchPageSuccess("dummy_map_key", {type: "page"});

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 0);

      sinon.assert.notCalled(loadNewPageStub);
    });

    it("navigate has been confirmed", () => {
      Hologram.prefetchedPages = new Map([
        [
          "dummy_map_key",
          {
            payload: null,
            isNavigateConfirmed: true,
            pagePath: "/my-page-path",
            timestamp: Date.now(),
          },
        ],
      ]);

      Hologram.handlePrefetchPageSuccess("dummy_map_key", {type: "page"});

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 0);

      sinon.assert.calledOnceWithExactly(loadNewPageStub, "/my-page-path", {
        type: "page",
      });
    });

    it("navigate hasn't been confirmed", () => {
      const mapKey = "dummy_map_key";
      const timestamp = Date.now();

      Hologram.prefetchedPages = new Map([
        [
          mapKey,
          {
            payload: null,
            isNavigateConfirmed: false,
            pagePath: "/my-page-path",
            timestamp: timestamp,
          },
        ],
      ]);

      Hologram.handlePrefetchPageSuccess(mapKey, {type: "page"});

      // Can't use assert.deepStrictEqual for Maps
      assert.instanceOf(Hologram.prefetchedPages, Map);
      assert.equal(Hologram.prefetchedPages.size, 1);
      assert.isTrue(Hologram.prefetchedPages.has(mapKey));

      const mapValue = Hologram.prefetchedPages.get(mapKey);

      assert.deepStrictEqual(mapValue, {
        payload: {type: "page"},
        isNavigateConfirmed: false,
        pagePath: "/my-page-path",
        timestamp: timestamp,
      });

      sinon.assert.notCalled(loadNewPageStub);
    });
  });

  describe("handleUncaughtError()", () => {
    let overlayShowStub;

    const boxedError = () =>
      new HologramBoxedError(Type.errorStruct("MyError", "my message"));

    beforeEach(() => {
      CallStack.reset();
      overlayShowStub = sinon.stub(UncaughtErrorOverlay, "show");
      globalThis.Hologram.config.errorOverlay = false;
    });

    afterEach(() => {
      overlayShowStub.restore();
      globalThis.Hologram.config.errorOverlay = false;
    });

    // The overlay reads the frames and the message off the error itself, so
    // it is handed the error rather than the report rendered from it.
    it("renders the error in the page when the overlay is enabled", () => {
      globalThis.Hologram.config.errorOverlay = true;

      const error = boxedError();

      Hologram.handleUncaughtError(error);

      sinon.assert.calledOnceWithExactly(overlayShowStub, error);
    });

    it("keeps the error out of the page when the overlay is disabled", () => {
      Hologram.handleUncaughtError(boxedError());

      sinon.assert.notCalled(overlayShowStub);
    });

    it("records the error for the feature test helpers", () => {
      Hologram.handleUncaughtError(boxedError());

      assert.deepStrictEqual(GlobalRegistry.get("lastBoxedError"), {
        module: "MyError",
        message: "my message",
      });
    });

    // Deriving here a second time would fault the same way the first one did,
    // leaving the error unreported - the very thing the reader needs to see.
    it("records an error that failed to derive its message, naming the fault", () => {
      const normalizeErrorStub = sinon
        .stub(Interpreter, "normalizeError")
        .callsFake(() => {
          throw new TypeError("my fault");
        });

      const error = new HologramBoxedError(Type.atom("badarg"));

      normalizeErrorStub.restore();

      Hologram.handleUncaughtError(error);

      assert.deepStrictEqual(GlobalRegistry.get("lastBoxedError"), {
        module: "error",
        message: ":badarg (message derivation failed: my fault)",
      });
    });

    it("ignores an error raised outside the runtime", () => {
      globalThis.Hologram.config.errorOverlay = true;

      const error = new Error("my message");

      Hologram.handleUncaughtError(error);

      assert.equal(error.message, "my message");
      sinon.assert.notCalled(overlayShowStub);
    });
  });

  describe("queueActionsFromServerInits()", () => {
    const cid1 = Type.bitstring("component_1");
    const cid2 = Type.bitstring("component_2");
    const cid3 = Type.bitstring("component_3");
    const cid4 = Type.bitstring("component_4");
    const cid5 = Type.bitstring("component_5");
    const cid6 = Type.bitstring("component_6");

    const action1 = Type.actionStruct({
      name: Type.atom("action_1"),
      params: Type.map(),
      target: Type.bitstring("my_target_1"),
    });

    const action2 = Type.actionStruct({
      name: Type.atom("action_2"),
      params: Type.map([[Type.atom("my_param"), Type.integer(42)]]),
      target: Type.bitstring("my_target_2"),
    });

    const action3 = Type.actionStruct({
      name: Type.atom("action_3"),
      params: Type.map(),
      target: Type.nil(),
    });

    const action6 = Type.actionStruct({
      name: Type.atom("action_6"),
      params: Type.map(),
      target: Type.bitstring("my_target_6"),
    });

    let entry1, entry2, entry3, entry4, entry5, entry6;

    beforeEach(() => {
      ComponentRegistry.clear();
      InitActionQueue.dequeueAll();

      entry1 = Type.map([
        [Type.atom("module"), Type.alias("Module1")],
        [Type.atom("struct"), Type.componentStruct({nextAction: action1})],
      ]);

      entry2 = Type.map([
        [Type.atom("module"), Type.alias("Module2")],
        [Type.atom("struct"), Type.componentStruct({nextAction: action2})],
      ]);

      entry3 = Type.map([
        [Type.atom("module"), Type.alias("Module3")],
        [Type.atom("struct"), Type.componentStruct({nextAction: action3})],
      ]);

      entry4 = Type.map([
        [Type.atom("module"), Type.alias("Module4")],
        [Type.atom("struct"), Type.componentStruct({nextAction: Type.nil()})],
      ]);

      entry5 = Type.map([
        [Type.atom("module"), Type.alias("Module5")],
        [Type.atom("struct"), Type.componentStruct({nextAction: Type.nil()})],
      ]);

      entry6 = Type.map([
        [Type.atom("module"), Type.alias("Module6")],
        [Type.atom("struct"), Type.componentStruct({nextAction: action6})],
      ]);
    });

    it("queues actions from all components that have next_action set", () => {
      ComponentRegistry.entries = Type.map([
        [cid1, entry1],
        [cid2, entry2],
      ]);

      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();
      assert.equal(queuedActions.length, 2);

      assert.deepStrictEqual(queuedActions[0], action1);
      assert.deepStrictEqual(queuedActions[1], action2);
    });

    it("skips components that don't have next_action set", () => {
      ComponentRegistry.entries = Type.map([
        [cid1, entry1],
        [cid4, entry4],
        [cid2, entry2],
      ]);

      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();
      assert.equal(queuedActions.length, 2);

      assert.deepStrictEqual(queuedActions[0], action1);
      assert.deepStrictEqual(queuedActions[1], action2);
    });

    it("handles empty component registry", () => {
      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();
      assert.equal(queuedActions.length, 0);
    });

    it("handles component registry with only components without next_action", () => {
      ComponentRegistry.entries = Type.map([
        [cid4, entry4],
        [cid5, entry5],
      ]);

      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();
      assert.equal(queuedActions.length, 0);
    });

    it("preserves existing target when action already has one", () => {
      ComponentRegistry.entries = Type.map([[cid1, entry1]]);

      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();

      // Should not modify the action
      assert.deepStrictEqual(queuedActions[0], action1);
    });

    it("adds component ID as target when action has nil target", () => {
      ComponentRegistry.entries = Type.map([[cid3, entry3]]);

      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();

      const expectedAction = Erlang_Maps["put/3"](
        Type.atom("target"),
        cid3,
        action3,
      );

      assert.deepStrictEqual(queuedActions[0], expectedAction);
    });

    it("processes components in the order they appear in the registry", () => {
      ComponentRegistry.entries = Type.map([
        [cid2, entry2],
        [cid6, entry6],
        [cid1, entry1],
      ]);

      Hologram.queueActionsFromServerInits();

      const queuedActions = InitActionQueue.dequeueAll();
      assert.equal(queuedActions.length, 3);

      assert.deepStrictEqual(queuedActions[0], action2);
      assert.deepStrictEqual(queuedActions[1], action6);
      assert.deepStrictEqual(queuedActions[2], action1);
    });

    it("clears next_action from the component struct in the registry after queueing", () => {
      ComponentRegistry.entries = Type.map([
        [cid1, entry1],
        [cid3, entry3],
      ]);

      Hologram.queueActionsFromServerInits();

      const struct1 = ComponentRegistry.getComponentStruct(cid1);
      const struct3 = ComponentRegistry.getComponentStruct(cid3);

      assert.deepStrictEqual(
        Erlang_Maps["get/2"](Type.atom("next_action"), struct1),
        Type.nil(),
      );

      assert.deepStrictEqual(
        Erlang_Maps["get/2"](Type.atom("next_action"), struct3),
        Type.nil(),
      );
    });
  });

  describe("queueSelfEchoes()", () => {
    const action1 = Type.actionStruct({
      name: Type.atom("self_echo_a"),
      params: Type.map(),
      target: Type.bitstring("page"),
    });

    const action2 = Type.actionStruct({
      name: Type.atom("self_echo_b"),
      params: Type.map([[Type.atom("text"), Type.bitstring("hi")]]),
      target: Type.bitstring("page"),
    });

    beforeEach(() => {
      InitActionQueue.dequeueAll();
    });

    it("does not enqueue anything when the list is empty", () => {
      Hologram.queueSelfEchoes(Type.list([]));

      assert.deepStrictEqual(InitActionQueue.dequeueAll(), []);
    });

    it("enqueues each action in order", () => {
      Hologram.queueSelfEchoes(Type.list([action1, action2]));

      assert.deepStrictEqual(InitActionQueue.dequeueAll(), [action1, action2]);
    });
  });

  describe("render()", () => {
    afterEach(() => {
      Hologram.virtualDocument = null;
      Renderer.listenerBindings = [];
      sinon.restore();
    });

    it("reconciles the global and resolved observer bindings collected during the render", () => {
      const listenerBindings = [
        {target: window, eventName: "keydown", handler: () => {}},
      ];

      const reachBinding = {
        target: {},
        key: "scroll-edge:bottom",
        attach: () => {},
        handler: () => {},
      };

      // renderPage() collects the page's <window>/<document> bindings into Renderer.listenerBindings.
      sinon.stub(Renderer, "renderPage").callsFake(() => {
        Renderer.listenerBindings = listenerBindings;
        return {sel: "html", data: {}, children: []};
      });

      // Observer bindings are resolved from their patched elements right before reconciliation.
      sinon.stub(Renderer, "resolveReachBindings").returns([reachBinding]);

      sinon.stub(Vdom, "patchVirtualDocument");
      const reconcileStub = sinon.stub(EventListenerRegistry, "reconcile");
      const recheckStub = sinon.stub(EventListeners, "recheckScrollEdges");

      Hologram.render();

      sinon.assert.calledOnceWithExactly(reconcileStub, [
        ...listenerBindings,
        reachBinding,
      ]);

      // Reach listeners persist, so each is rechecked after reconcile to re-sync and auto-fill.
      sinon.assert.calledOnce(recheckStub);
      sinon.assert.callOrder(reconcileStub, recheckStub);
    });

    // A full document load has no previous render to diff against, only the page the server sent,
    // so the old side is this render mirrored onto it. Reading the page into a vdom of its own
    // instead would describe it in terms the render never uses, and every node would be rebuilt.
    it("seeds the first render by mirroring it onto the page the server sent", () => {
      const renderedVirtualDocument = {sel: "html", data: {}, children: []};
      const mirroredVirtualDocument = {sel: "html", data: {}, children: []};

      sinon.stub(Renderer, "renderPage").returns(renderedVirtualDocument);
      const mirrorStub = sinon
        .stub(Vdom, "mirror")
        .returns(mirroredVirtualDocument);
      const patchStub = sinon.stub(Vdom, "patchVirtualDocument");

      Hologram.virtualDocument = null;

      Hologram.render();

      sinon.assert.calledOnceWithExactly(
        mirrorStub,
        renderedVirtualDocument,
        document.documentElement,
      );

      sinon.assert.calledOnceWithExactly(
        patchStub,
        mirroredVirtualDocument,
        renderedVirtualDocument,
      );
    });

    it("leaves a render that has a previous one to diff against alone", () => {
      const previousVirtualDocument = {sel: "html", data: {}, children: []};
      const renderedVirtualDocument = {sel: "html", data: {}, children: []};

      sinon.stub(Renderer, "renderPage").returns(renderedVirtualDocument);
      const mirrorStub = sinon.stub(Vdom, "mirror");
      const patchStub = sinon.stub(Vdom, "patchVirtualDocument");

      Hologram.virtualDocument = previousVirtualDocument;

      Hologram.render();

      sinon.assert.notCalled(mirrorStub);

      sinon.assert.calledOnceWithExactly(
        patchStub,
        previousVirtualDocument,
        renderedVirtualDocument,
      );
    });
  });

  describe("scheduleAction()", () => {
    let clock, executeActionStub;

    const action1 = Type.actionStruct({
      name: Type.atom("test_action"),
      params: Type.map(),
      target: cid1,
    });

    beforeEach(() => {
      clock = sinon.useFakeTimers();

      executeActionStub = sinon
        .stub(Hologram, "executeAction")
        .callsFake((_action) => null);
    });

    afterEach(() => {
      clock.restore();
      sinon.restore();
    });

    it("schedules action execution with setTimeout and 0 delay", () => {
      // Before scheduling, executeAction should not have been called
      sinon.assert.notCalled(executeActionStub);

      Hologram.scheduleAction(action1);

      // Action should not execute immediately
      sinon.assert.notCalled(executeActionStub);

      // Advance time by 0ms to trigger setTimeout callback
      clock.tick(0);

      // Now the action should have been executed
      sinon.assert.calledOnceWithExactly(executeActionStub, action1);
    });

    it("schedules multiple actions independently", () => {
      const action2 = Type.actionStruct({
        name: Type.atom("test_action_2"),
        params: Type.map(),
        target: Type.bitstring("component_2"),
      });

      Hologram.scheduleAction(action1);
      Hologram.scheduleAction(action2);

      // Neither should execute immediately
      sinon.assert.notCalled(executeActionStub);

      // Both should execute after time advancement
      clock.tick(0);

      sinon.assert.calledTwice(executeActionStub);
      sinon.assert.calledWith(executeActionStub.getCall(0), action1);
      sinon.assert.calledWith(executeActionStub.getCall(1), action2);
    });

    it("schedules action execution with custom delay", () => {
      const actionWithDelay = Type.actionStruct({
        name: Type.atom("test_action_with_delay"),
        params: Type.map(),
        target: cid1,
        delay: Type.integer(500),
      });

      sinon.assert.notCalled(executeActionStub);

      Hologram.scheduleAction(actionWithDelay);

      // Action should not execute immediately
      sinon.assert.notCalled(executeActionStub);

      // Action should not execute after short delay
      clock.tick(100);
      sinon.assert.notCalled(executeActionStub);

      // Action should execute after specified delay
      clock.tick(400);
      sinon.assert.calledOnceWithExactly(executeActionStub, actionWithDelay);
    });

    it("schedules multiple actions with different delays in correct order", () => {
      const actionDelayed100 = Type.actionStruct({
        name: Type.atom("action_100ms"),
        params: Type.map(),
        target: cid1,
        delay: Type.integer(100),
      });

      const actionDelayed300 = Type.actionStruct({
        name: Type.atom("action_300ms"),
        params: Type.map(),
        target: cid1,
        delay: Type.integer(300),
      });

      Hologram.scheduleAction(actionDelayed300);
      Hologram.scheduleAction(actionDelayed100);

      // Neither should execute immediately
      sinon.assert.notCalled(executeActionStub);

      // After 100ms, only the first action should execute
      clock.tick(100);
      sinon.assert.calledOnceWithExactly(executeActionStub, actionDelayed100);

      // After another 200ms (total 300ms), the second action should execute
      clock.tick(200);
      sinon.assert.calledTwice(executeActionStub);
      sinon.assert.calledWith(executeActionStub.getCall(1), actionDelayed300);
    });

    it("handles action with zero delay same as no delay specified", () => {
      const actionZeroDelay = Type.actionStruct({
        name: Type.atom("test_action_zero_delay"),
        params: Type.map(),
        target: cid1,
        delay: Type.integer(0),
      });

      Hologram.scheduleAction(actionZeroDelay);

      // Action should not execute immediately
      sinon.assert.notCalled(executeActionStub);

      // Action should execute after 0ms timeout
      clock.tick(0);
      sinon.assert.calledOnceWithExactly(executeActionStub, actionZeroDelay);
    });
  });
});
