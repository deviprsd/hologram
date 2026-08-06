"use strict";

// Based on Elixir Hologram.Template.MarkerTest - the accept/reject table for key_from_value/1 in
// particular has to match its Elixir twin exactly (see lib/hologram/template/marker.ex), since a
// key that one side derives and the other rejects would desync the vdom the client boots from
// server-rendered markup from the vdom it renders itself.

import {
  assert,
  contextFixture,
  defineRuntimeGlobals,
} from "../../../support/helpers.mjs";

import Elixir_Hologram_Template_Marker from "../../../../../assets/js/elixir/hologram/template/marker.mjs";
import ItemCache from "../../../../../assets/js/item_cache.mjs";
import Type from "../../../../../assets/js/type.mjs";

defineRuntimeGlobals();

const item_key = Elixir_Hologram_Template_Marker["item_key/1"];
const item_node = Elixir_Hologram_Template_Marker["item_node/4"];
const key_from_value = Elixir_Hologram_Template_Marker["key_from_value/1"];
const memoized_item = Elixir_Hologram_Template_Marker["memoized_item/5"];

// Wraps a JS thunk as a boxed 0-arity anonymous function, the shape a compiled `fn -> ... end`
// item body arrives as. Counts its own calls, so tests can assert a cache hit skipped it.
const trackedThunk = (value) => {
  const calls = {count: 0};

  const fun = Type.anonymousFunction(
    0,
    [
      {
        params: () => [],
        guards: [],
        body: () => {
          calls.count += 1;
          return value;
        },
      },
    ],
    contextFixture(),
  );

  return [fun, calls];
};

const mapItem = (id) =>
  Type.map([
    [Type.atom("id"), id],
    [Type.atom("name"), Type.bitstring("Alice")],
  ]);

describe("Elixir_Hologram_Template_Marker", () => {
  describe("item_key/1", () => {
    it("map with integer :id", () => {
      assert.deepStrictEqual(
        item_key(mapItem(Type.integer(1))),
        Type.bitstring("1"),
      );
    });

    it("map with binary :id", () => {
      assert.deepStrictEqual(
        item_key(mapItem(Type.bitstring("abc-def"))),
        Type.bitstring("abc-def"),
      );
    });

    it("map with atom :id", () => {
      assert.deepStrictEqual(
        item_key(mapItem(Type.atom("active"))),
        Type.bitstring("active"),
      );
    });

    it("map without :id", () => {
      assert.deepStrictEqual(
        item_key(Type.map([[Type.atom("name"), Type.bitstring("Alice")]])),
        Type.nil(),
      );
    });

    it("not a map", () => {
      assert.deepStrictEqual(item_key(Type.bitstring("plain")), Type.nil());
      assert.deepStrictEqual(item_key(Type.integer(123)), Type.nil());
      assert.deepStrictEqual(item_key(Type.nil()), Type.nil());
      assert.deepStrictEqual(
        item_key(Type.list([Type.integer(1), Type.integer(2)])),
        Type.nil(),
      );
    });

    it("map with nil :id", () => {
      assert.deepStrictEqual(item_key(mapItem(Type.nil())), Type.nil());
    });

    it("map with boolean :id", () => {
      assert.deepStrictEqual(item_key(mapItem(Type.atom("true"))), Type.nil());
      assert.deepStrictEqual(item_key(mapItem(Type.atom("false"))), Type.nil());
    });

    it("map with :id of an unsupported type", () => {
      assert.deepStrictEqual(item_key(mapItem(Type.float(1.5))), Type.nil());
      assert.deepStrictEqual(
        item_key(mapItem(Type.tuple([Type.integer(1), Type.integer(2)]))),
        Type.nil(),
      );
    });
  });

  describe("key_from_value/1", () => {
    it("binary", () => {
      assert.deepStrictEqual(
        key_from_value(Type.bitstring("abc")),
        Type.bitstring("abc"),
      );
    });

    it("integer", () => {
      assert.deepStrictEqual(
        key_from_value(Type.integer(42)),
        Type.bitstring("42"),
      );
      assert.deepStrictEqual(
        key_from_value(Type.integer(-1)),
        Type.bitstring("-1"),
      );
    });

    it("atom", () => {
      assert.deepStrictEqual(
        key_from_value(Type.atom("active")),
        Type.bitstring("active"),
      );
    });

    it("nil", () => {
      assert.deepStrictEqual(key_from_value(Type.nil()), Type.nil());
    });

    it("boolean", () => {
      assert.deepStrictEqual(key_from_value(Type.atom("true")), Type.nil());
      assert.deepStrictEqual(key_from_value(Type.atom("false")), Type.nil());
    });

    it("float", () => {
      assert.deepStrictEqual(key_from_value(Type.float(1.5)), Type.nil());
    });

    it("tuple", () => {
      assert.deepStrictEqual(
        key_from_value(Type.tuple([Type.integer(1), Type.integer(2)])),
        Type.nil(),
      );
    });

    it("list", () => {
      assert.deepStrictEqual(
        key_from_value(Type.list([Type.integer(1), Type.integer(2)])),
        Type.nil(),
      );
    });

    it("map", () => {
      assert.deepStrictEqual(
        key_from_value(Type.map([[Type.atom("a"), Type.integer(1)]])),
        Type.nil(),
      );
    });

    it("empty binary", () => {
      assert.deepStrictEqual(key_from_value(Type.bitstring("")), Type.nil());
    });

    it("binary containing --", () => {
      assert.deepStrictEqual(
        key_from_value(Type.bitstring("a--b")),
        Type.nil(),
      );
    });

    it("binary at the max length", () => {
      const key = "a".repeat(128);
      assert.deepStrictEqual(
        key_from_value(Type.bitstring(key)),
        Type.bitstring(key),
      );
    });

    it("binary over the max length", () => {
      assert.deepStrictEqual(
        key_from_value(Type.bitstring("a".repeat(129))),
        Type.nil(),
      );
    });

    it("binary with characters outside the allowed set", () => {
      assert.deepStrictEqual(key_from_value(Type.bitstring("a b")), Type.nil());
      assert.deepStrictEqual(key_from_value(Type.bitstring("a:b")), Type.nil());
      assert.deepStrictEqual(key_from_value(Type.bitstring("a<b")), Type.nil());
      assert.deepStrictEqual(key_from_value(Type.bitstring("a&b")), Type.nil());
      assert.deepStrictEqual(key_from_value(Type.bitstring('a"b')), Type.nil());
    });

    it("binary with all allowed non-alphanumeric characters", () => {
      const key = "a_b.c@d|e~f+g-h";
      assert.deepStrictEqual(
        key_from_value(Type.bitstring(key)),
        Type.bitstring(key),
      );
    });
  });

  describe("item_node/4", () => {
    it("with a key", () => {
      const result = item_node(
        Type.bitstring("42"),
        Type.bitstring("abc123"),
        Type.integer(0),
        Type.bitstring("o"),
      );

      assert.deepStrictEqual(
        result,
        Type.tuple([
          Type.atom("public_comment"),
          Type.list([
            Type.tuple([
              Type.atom("text"),
              Type.bitstring("[h:abc123:0:42:o]"),
            ]),
          ]),
        ]),
      );
    });

    it("with a key, closing side", () => {
      const result = item_node(
        Type.bitstring("42"),
        Type.bitstring("abc123"),
        Type.integer(0),
        Type.bitstring("c"),
      );

      assert.deepStrictEqual(
        result,
        Type.tuple([
          Type.atom("public_comment"),
          Type.list([
            Type.tuple([
              Type.atom("text"),
              Type.bitstring("[h:abc123:0:42:c]"),
            ]),
          ]),
        ]),
      );
    });

    it("without a key", () => {
      const result = item_node(
        Type.nil(),
        Type.bitstring("abc123"),
        Type.integer(0),
        Type.bitstring("o"),
      );

      assert.deepStrictEqual(result, Type.nil());
    });
  });

  describe("memoized_item/5", () => {
    beforeEach(() => {
      ItemCache.clear();
      globalThis.hologramItemMemoDisabled = false;
    });

    it("nil key: never caches, always calls item_fun", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("abc"));

      memoized_item(
        Type.nil(),
        Type.bitstring("h"),
        Type.integer(0),
        Type.list([]),
        fun,
      );
      memoized_item(
        Type.nil(),
        Type.bitstring("h"),
        Type.integer(0),
        Type.list([]),
        fun,
      );

      assert.equal(calls.count, 2);
    });

    it("same key and guards: second call is a hit, item_fun runs once", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("abc"));
      const guards = Type.list([Type.integer(1)]);

      const first = memoized_item(
        Type.bitstring("k"),
        Type.bitstring("h"),
        Type.integer(0),
        guards,
        fun,
      );

      const second = memoized_item(
        Type.bitstring("k"),
        Type.bitstring("h"),
        Type.integer(0),
        guards,
        fun,
      );

      assert.equal(calls.count, 1);
      assert.strictEqual(first, second);
    });

    it("a changed guard value is a miss", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("abc"));

      memoized_item(
        Type.bitstring("k"),
        Type.bitstring("h"),
        Type.integer(0),
        Type.list([Type.integer(1)]),
        fun,
      );

      memoized_item(
        Type.bitstring("k"),
        Type.bitstring("h"),
        Type.integer(0),
        Type.list([Type.integer(2)]),
        fun,
      );

      assert.equal(calls.count, 2);
    });
  });
});
