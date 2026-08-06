"use strict";

// Hand-ported twin of lib/hologram/template/marker.ex - keep both in sync, especially
// key_from_value/1, whose accept/reject rules have to agree exactly so the client and the server
// arrive at the same marker text for the same item.

import Bitstring from "../../../bitstring.mjs";
import Erlang_Maps from "../../../erlang/maps.mjs";
import Type from "../../../type.mjs";

const MAX_KEY_LENGTH = 128;

// Mirrors Hologram.Template.Marker's @key_regex.
const KEY_REGEX = /^[A-Za-z0-9_.@|~+-]+$/;

// Byte length, not character length, so a multi-byte UTF-8 identifier is capped the same way
// Elixir's byte_size/1 caps it server side. The key charset is ASCII-only, so a text that passes
// KEY_REGEX always has byteLength === text.length anyway - encoding first keeps the length check
// meaningful even if the charset is ever widened to allow non-ASCII.
const textEncoder = new TextEncoder();

const validateKeyText = (text) => {
  const byteLength = textEncoder.encode(text).length;

  return byteLength >= 1 &&
    byteLength <= MAX_KEY_LENGTH &&
    !text.includes("--") &&
    KEY_REGEX.test(text)
    ? Type.bitstring(text)
    : Type.nil();
};

const Elixir_Hologram_Template_Marker = {
  // Start item_key/1
  "item_key/1": (item) => {
    if (
      !Type.isMap(item) ||
      Type.isFalse(Erlang_Maps["is_key/2"](Type.atom("id"), item))
    ) {
      return Type.nil();
    }

    const id = Erlang_Maps["get/2"](Type.atom("id"), item);

    return Elixir_Hologram_Template_Marker["key_from_value/1"](id);
  },
  // End item_key/1
  // Deps: [:maps.get/2, :maps.is_key/2]

  // Start item_node/4
  "item_node/4": (key, hash, index, side) => {
    if (Type.isNil(key)) {
      return Type.nil();
    }

    const commentText = `[h:${Bitstring.toText(hash)}:${index.value}:${Bitstring.toText(key)}:${Bitstring.toText(side)}]`;

    return Type.tuple([
      Type.atom("public_comment"),
      Type.list([Type.tuple([Type.atom("text"), Type.bitstring(commentText)])]),
    ]);
  },
  // End item_node/4
  // Deps: []

  // Start key_from_value/1
  "key_from_value/1": (value) => {
    if (Type.isBinary(value)) {
      return validateKeyText(Bitstring.toText(value));
    }

    if (Type.isInteger(value)) {
      return validateKeyText(value.value.toString());
    }

    if (Type.isAtom(value) && !Type.isNil(value) && !Type.isBoolean(value)) {
      return validateKeyText(value.value);
    }

    return Type.nil();
  },
  // End key_from_value/1
  // Deps: []
};

export default Elixir_Hologram_Template_Marker;
