"use strict";

import {
  assert,
  contextFixture,
  defineRuntimeGlobals,
} from "./support/helpers.mjs";

import ItemCache from "../../assets/js/item_cache.mjs";
import Type from "../../assets/js/type.mjs";

defineRuntimeGlobals();

const thunk = (value) =>
  Type.anonymousFunction(
    0,
    [{params: () => [], guards: [], body: () => value}],
    contextFixture(),
  );

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

const h = Type.bitstring("h");
const i0 = Type.integer(0);

describe("ItemCache", () => {
  beforeEach(() => {
    ItemCache.clear();
    globalThis.hologramItemMemoDisabled = false;
  });

  describe("memoizedItem", () => {
    it("nil key bypasses the cache entirely", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));

      ItemCache.memoizedItem(Type.nil(), h, i0, [], fun);
      ItemCache.memoizedItem(Type.nil(), h, i0, [], fun);

      assert.equal(calls.count, 2);
    });

    it("a miss stores the result and counts a miss", () => {
      const result = ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        [Type.integer(1)],
        thunk(Type.bitstring("x")),
      );

      assert.deepStrictEqual(result, Type.bitstring("x"));
      assert.equal(ItemCache.hits, 0);
      assert.equal(ItemCache.misses, 1);
    });

    it("same key, same guards: a hit returns the identical stored term without calling item_fun", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));
      const guards = [Type.integer(1)];

      const first = ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        guards,
        fun,
      );
      const second = ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        guards,
        fun,
      );

      assert.equal(calls.count, 1);
      assert.strictEqual(first, second);
      assert.equal(ItemCache.hits, 1);
      assert.equal(ItemCache.misses, 1);
    });

    it("a changed scalar guard value is a miss", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));

      ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        [Type.integer(1)],
        fun,
      );
      ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        [Type.integer(2)],
        fun,
      );

      assert.equal(calls.count, 2);
    });

    it("a changed guard list length is a miss", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));

      ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        [Type.integer(1)],
        fun,
      );
      ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        [Type.integer(1), Type.integer(2)],
        fun,
      );

      assert.equal(calls.count, 2);
    });

    it("a reference-changed composite (map) guard is a miss, even with equal content", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));
      const mapA = Type.map([[Type.atom("a"), Type.integer(1)]]);
      const mapB = Type.map([[Type.atom("a"), Type.integer(1)]]);

      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, [mapA], fun);
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, [mapB], fun);

      assert.equal(calls.count, 2);
    });

    it("a reference-identical composite (map) guard is a hit", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));
      const map = Type.map([[Type.atom("a"), Type.integer(1)]]);

      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, [map], fun);
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, [map], fun);

      assert.equal(calls.count, 1);
    });

    it("different item keys at the same call site are independent entries", () => {
      const [funA, callsA] = trackedThunk(Type.bitstring("a"));
      const [funB, callsB] = trackedThunk(Type.bitstring("b"));

      ItemCache.memoizedItem(Type.bitstring("a"), h, i0, [], funA);
      ItemCache.memoizedItem(Type.bitstring("b"), h, i0, [], funB);
      ItemCache.memoizedItem(Type.bitstring("a"), h, i0, [], funA);
      ItemCache.memoizedItem(Type.bitstring("b"), h, i0, [], funB);

      assert.equal(callsA.count, 1);
      assert.equal(callsB.count, 1);
    });

    it("hologramItemMemoDisabled bypasses lookup, but re-enabling can still hit the entry it wrote", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));
      const guards = [Type.integer(1)];

      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);

      globalThis.hologramItemMemoDisabled = true;
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);
      globalThis.hologramItemMemoDisabled = false;

      // Re-enabling doesn't start from an artificially stale cache: the disabled-path call above
      // still wrote a fresh entry, so this is a hit rather than a third evaluation.
      const result = ItemCache.memoizedItem(
        Type.bitstring("k"),
        h,
        i0,
        guards,
        fun,
      );

      assert.equal(calls.count, 2);
      assert.deepStrictEqual(result, Type.bitstring("x"));
    });
  });

  describe("beginRender / endRender", () => {
    it("evicts an entry never touched during the render", () => {
      const [fun] = trackedThunk(Type.bitstring("x"));
      const guards = [Type.integer(1)];

      ItemCache.beginRender();
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);
      ItemCache.endRender();

      // Not touched this render - scrolled out of the window.
      ItemCache.beginRender();
      ItemCache.endRender();

      const [fun2, calls2] = trackedThunk(Type.bitstring("x"));
      ItemCache.beginRender();
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun2);
      ItemCache.endRender();

      assert.equal(calls2.count, 1);
    });

    it("keeps an entry touched every render", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));
      const guards = [Type.integer(1)];

      ItemCache.beginRender();
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);
      ItemCache.endRender();

      ItemCache.beginRender();
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);
      ItemCache.endRender();

      assert.equal(calls.count, 1);
    });

    it("resets hit/miss counters on beginRender", () => {
      const [fun] = trackedThunk(Type.bitstring("x"));
      const guards = [Type.integer(1)];

      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);

      assert.equal(ItemCache.hits, 1);
      assert.equal(ItemCache.misses, 1);

      ItemCache.beginRender();

      assert.equal(ItemCache.hits, 0);
      assert.equal(ItemCache.misses, 0);
    });
  });

  describe("clear", () => {
    it("drops all entries and resets counters", () => {
      const [fun, calls] = trackedThunk(Type.bitstring("x"));
      const guards = [Type.integer(1)];

      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);
      ItemCache.clear();
      ItemCache.memoizedItem(Type.bitstring("k"), h, i0, guards, fun);

      assert.equal(calls.count, 2);
      assert.equal(ItemCache.hits, 0);
      assert.equal(ItemCache.misses, 1);
    });
  });

  // Oracle: whatever ItemCache returns (hit or miss) must always deepStrictEqual what a fresh,
  // uncached evaluation of the same (key, guards) would produce - the property that actually
  // matters, since a hit that returns the *wrong* term would be a silently stale row. Runs a
  // seeded (deterministic, no flakiness) sequence of add/remove/edit/no-op steps over a small set
  // of keys, checking that invariant after every single step rather than just at the end.
  describe("oracle: random add/remove/edit sequence", () => {
    it("never returns a term other than what a fresh evaluation would produce", () => {
      // mulberry32
      let seed = 0x2f6e2b1;
      const nextRandom = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      const keys = ["a", "b", "c", "d", "e"];
      const model = new Map(); // key -> guard value (int)

      const freshDom = (key, value) =>
        Type.tuple([Type.bitstring(key), Type.integer(value)]);

      for (let step = 0; step < 500; step += 1) {
        const key = keys[Math.floor(nextRandom() * keys.length)];
        const action = nextRandom();

        if (action < 0.3) {
          model.delete(key);
        } else {
          model.set(key, Math.floor(nextRandom() * 5));
        }

        ItemCache.beginRender();

        for (const [presentKey, value] of model) {
          const result = ItemCache.memoizedItem(
            Type.bitstring(presentKey),
            h,
            i0,
            [Type.integer(value)],
            thunk(freshDom(presentKey, value)),
          );

          assert.deepStrictEqual(
            result,
            freshDom(presentKey, value),
            `step ${step}, key ${presentKey}`,
          );
        }

        ItemCache.endRender();
      }
    });
  });
});
