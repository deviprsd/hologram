"use strict";

import {assert, defineRuntimeGlobals} from "../support/helpers.mjs";

import ClickOutsideEvent from "../../../assets/js/events/click_outside_event.mjs";
import PointerEvent from "../../../assets/js/events/pointer_event.mjs";

defineRuntimeGlobals();

describe("ClickOutsideEvent", () => {
  it("buildOperationParam()", () => {
    const event = {
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
    };

    assert.deepStrictEqual(
      ClickOutsideEvent.buildOperationParam(event),
      PointerEvent.buildOperationParam(event),
    );
  });

  it("isEventIgnored()", () => {
    assert.isFalse(ClickOutsideEvent.isEventIgnored({}));
  });
});
