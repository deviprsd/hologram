"use strict";

import Bitstring from "../bitstring.mjs";
import Type from "../type.mjs";

// Maps each modifier key name to the live event's corresponding boolean property.
const MODIFIER_FLAGS = {
  alt: "altKey",
  ctrl: "ctrlKey",
  meta: "metaKey",
  shift: "shiftKey",
};

export default class KeyboardEvent {
  // Allow the browser's default action (typing, caret movement, etc.); an
  // automatic preventDefault would block keyboard input.
  static isDefaultAllowed = true;

  static buildOperationParam(event) {
    return Type.map([
      [Type.atom("alt_key"), Type.boolean(event.altKey)],
      [Type.atom("code"), Type.bitstring(event.code)],
      [Type.atom("ctrl_key"), Type.boolean(event.ctrlKey)],
      // True while an IME composition session (e.g. Japanese/Chinese input) is in progress -
      // a handler committing on Enter needs this to avoid firing mid-composition.
      [Type.atom("is_composing"), Type.boolean(event.isComposing ?? false)],
      [Type.atom("key"), Type.bitstring(event.key)],
      [Type.atom("meta_key"), Type.boolean(event.metaKey)],
      [Type.atom("repeat"), Type.boolean(event.repeat)],
      // event.target only exposes selectionStart/selectionEnd on text-editable elements
      // (input/textarea); a keydown bound on a non-editable container (e.g. a div) has
      // neither, so both fall back to nil rather than a misleading 0.
      [
        Type.atom("selection_end"),
        event.target?.selectionEnd != null
          ? Type.integer(event.target.selectionEnd)
          : Type.nil(),
      ],
      [
        Type.atom("selection_start"),
        event.target?.selectionStart != null
          ? Type.integer(event.target.selectionStart)
          : Type.nil(),
      ],
      [Type.atom("shift_key"), Type.boolean(event.shiftKey)],
    ]);
  }

  static isEventIgnored(_event) {
    return false;
  }

  // Decides whether a key filter (the values of a {:key, values} modifier) matches a live
  // event. Each value is either a modifier key, checked against the event's boolean flag, or
  // the key itself, compared against the lowercased event.key (already the canonical form).
  static matchesKeyFilter(filterValues, event) {
    const eventKey = event.key.toLowerCase();

    return filterValues.data.every((boxedValue) => {
      const value = Bitstring.toText(boxedValue);
      const flag = MODIFIER_FLAGS[value];

      return flag ? event[flag] === true : value === eventKey;
    });
  }
}
