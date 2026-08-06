"use strict";

import { assert } from "./support/helpers.mjs";

import MapData from "../../assets/js/map_data.mjs";

// Deterministic PRNG (mulberry32), not Math.random() - this file's whole
// point is to catch subtle trie bugs by brute force, and a failure that
// can't be reproduced on the next run is close to useless for that.
function mulberry32(seed) {
  let a = seed;

  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Interleaved random put/remove against MapData, mirrored on a plain JS
// Map, asserting agreement after every single operation - contents and
// size, not just the end state. Iteration order is NOT asserted here: the
// trie itself is order-agnostic (see map_data.mjs's module doc) - insertion
// order is tracked by Type's TrieMap, one layer up, and covered there.
function runOracle(rand, operationCount, keyPoolSize) {
  const reference = new Map();
  let root = MapData.EMPTY;

  for (let i = 0; i < operationCount; ++i) {
    const key = `k${Math.floor(rand() * keyPoolSize)}`;
    const isPut = rand() < 0.7; // bias toward puts so the map actually grows

    if (isPut) {
      const value = `v${i}`;
      const wasPresent = reference.has(key);
      const result = MapData.put(root, key, value);
      root = result.root;
      reference.set(key, value);

      assert.strictEqual(
        result.added,
        !wasPresent,
        `put(${key}) added flag wrong at op ${i}`,
      );
    } else {
      const wasPresent = reference.has(key);
      const result = MapData.remove(root, key);
      root = result.root;
      reference.delete(key);

      assert.strictEqual(
        result.removed,
        wasPresent,
        `remove(${key}) removed flag wrong at op ${i}`,
      );
    }

    assert.strictEqual(
      MapData.sizeSlow(root),
      reference.size,
      `size mismatch at op ${i}`,
    );

    for (const [refKey, refValue] of reference) {
      assert.strictEqual(
        MapData.get(root, refKey),
        refValue,
        `get(${refKey}) mismatch at op ${i}`,
      );
      assert.isTrue(
        MapData.has(root, refKey),
        `has(${refKey}) wrong at op ${i}`,
      );
    }

    const actualKeys = MapData.entries(root)
      .map(([k]) => k)
      .sort();
    const expectedKeys = [...reference.keys()].sort();

    assert.deepStrictEqual(
      actualKeys,
      expectedKeys,
      `entries() contents mismatch at op ${i}`,
    );
  }
}

describe("MapData", () => {
  afterEach(() => {
    MapData._resetHashBitsForTesting();
  });

  describe("get()/has()", () => {
    it("returns undefined/false for an empty trie", () => {
      assert.isUndefined(MapData.get(MapData.EMPTY, "a"));
      assert.isFalse(MapData.has(MapData.EMPTY, "a"));
    });

    it("returns the value/true for a present key", () => {
      const { root } = MapData.put(MapData.EMPTY, "a", 1);

      assert.strictEqual(MapData.get(root, "a"), 1);
      assert.isTrue(MapData.has(root, "a"));
    });

    it("returns undefined/false for an absent key in a non-empty trie", () => {
      const { root } = MapData.put(MapData.EMPTY, "a", 1);

      assert.isUndefined(MapData.get(root, "b"));
      assert.isFalse(MapData.has(root, "b"));
    });
  });

  describe("put()", () => {
    it("reports added: true for a brand-new key", () => {
      const result = MapData.put(MapData.EMPTY, "a", 1);

      assert.isTrue(result.added);
    });

    it("reports added: false for a value-only update on an existing key", () => {
      const { root } = MapData.put(MapData.EMPTY, "a", 1);
      const result = MapData.put(root, "a", 2);

      assert.isFalse(result.added);
      assert.strictEqual(MapData.get(result.root, "a"), 2);
    });

    it("never mutates the previous root - old root keeps its old contents", () => {
      const { root: root1 } = MapData.put(MapData.EMPTY, "a", 1);
      const { root: root2 } = MapData.put(root1, "a", 2);

      assert.strictEqual(MapData.get(root1, "a"), 1);
      assert.strictEqual(MapData.get(root2, "a"), 2);
    });

    it("updates the value in place without disturbing sibling keys", () => {
      let root = MapData.EMPTY;
      root = MapData.put(root, "a", 1).root;
      root = MapData.put(root, "b", 2).root;
      root = MapData.put(root, "a", 99).root;

      assert.strictEqual(MapData.get(root, "a"), 99);
      assert.strictEqual(MapData.get(root, "b"), 2);
      assert.strictEqual(MapData.sizeSlow(root), 2);
    });
  });

  describe("remove()", () => {
    it("reports removed: false for an absent key", () => {
      const result = MapData.remove(MapData.EMPTY, "a");

      assert.isFalse(result.removed);
      assert.strictEqual(result.root, MapData.EMPTY);
    });

    it("reports removed: true and drops the key", () => {
      const { root } = MapData.put(MapData.EMPTY, "a", 1);
      const result = MapData.remove(root, "a");

      assert.isTrue(result.removed);
      assert.isFalse(MapData.has(result.root, "a"));
    });

    it("never mutates the previous root", () => {
      const { root: root1 } = MapData.put(MapData.EMPTY, "a", 1);
      const { root: root2 } = MapData.remove(root1, "a");

      assert.isTrue(MapData.has(root1, "a"));
      assert.isFalse(MapData.has(root2, "a"));
    });

    it("leaves the other keys of a multi-key trie intact", () => {
      let root = MapData.EMPTY;
      root = MapData.put(root, "a", 1).root;
      root = MapData.put(root, "b", 2).root;
      root = MapData.put(root, "c", 3).root;
      root = MapData.remove(root, "b").root;

      assert.sameDeepMembers(MapData.entries(root), [
        ["a", 1],
        ["c", 3],
      ]);
    });
  });

  describe("entries()", () => {
    it("returns an empty array for an empty trie", () => {
      assert.deepStrictEqual(MapData.entries(MapData.EMPTY), []);
    });

    it("returns all [key, value] pairs", () => {
      let root = MapData.EMPTY;
      root = MapData.put(root, "z", 1).root;
      root = MapData.put(root, "a", 2).root;
      root = MapData.put(root, "m", 3).root;

      assert.sameDeepMembers(MapData.entries(root), [
        ["z", 1],
        ["a", 2],
        ["m", 3],
      ]);
    });
  });

  describe("fromEntries()", () => {
    it("builds the same trie as sequential put() calls", () => {
      const pairs = [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ];

      const { root, size } = MapData.fromEntries(pairs);

      assert.strictEqual(size, 3);
      assert.sameDeepMembers(MapData.entries(root), pairs);
    });

    it("keeps the last occurrence's value for duplicate keys, matching plain-object literal semantics", () => {
      const pairs = [
        ["a", 1],
        ["b", 2],
        ["a", 3],
      ];

      const { root, size } = MapData.fromEntries(pairs);

      assert.strictEqual(size, 2);
      assert.sameDeepMembers(MapData.entries(root), [
        ["a", 3],
        ["b", 2],
      ]);
    });

    it("produces a trie a further put() can keep growing", () => {
      const { root } = MapData.fromEntries([
        ["a", 1],
        ["b", 2],
      ]);

      const result = MapData.put(root, "c", 3);

      assert.sameDeepMembers(MapData.entries(result.root), [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);
    });
  });

  describe("collisions", () => {
    it("stores and retrieves multiple keys forced into the same hash bucket", () => {
      // 1 usable hash bit => only 2 buckets; a handful of distinct keys is
      // certain to collide.
      MapData._setHashBitsForTesting(1);

      let root = MapData.EMPTY;
      const keys = ["a", "b", "c", "d", "e"];

      keys.forEach((key, i) => {
        root = MapData.put(root, key, i).root;
      });

      keys.forEach((key, i) => {
        assert.strictEqual(MapData.get(root, key), i);
      });

      assert.strictEqual(MapData.sizeSlow(root), keys.length);
    });

    it("removes one colliding key without disturbing the others", () => {
      MapData._setHashBitsForTesting(1);

      let root = MapData.EMPTY;
      root = MapData.put(root, "a", 1).root;
      root = MapData.put(root, "b", 2).root;
      root = MapData.put(root, "c", 3).root;
      root = MapData.remove(root, "b").root;

      assert.isFalse(MapData.has(root, "b"));
      assert.strictEqual(MapData.get(root, "a"), 1);
      assert.strictEqual(MapData.get(root, "c"), 3);
    });

    it("updates a colliding key's value without affecting its siblings", () => {
      MapData._setHashBitsForTesting(1);

      let root = MapData.EMPTY;
      root = MapData.put(root, "a", 1).root;
      root = MapData.put(root, "b", 2).root;
      root = MapData.put(root, "a", 99).root;

      assert.strictEqual(MapData.get(root, "a"), 99);
      assert.strictEqual(MapData.get(root, "b"), 2);
    });
  });

  describe("randomized oracle", () => {
    it("agrees with a plain JS Map over 3000 interleaved put/remove ops at full (32-bit) hash width", () => {
      runOracle(mulberry32(1), 3000, 200);
    });

    it("agrees with a plain JS Map over 2000 interleaved put/remove ops with hash bits narrowed to force frequent collisions", () => {
      MapData._setHashBitsForTesting(4); // 16 buckets, 300 possible keys
      runOracle(mulberry32(2), 2000, 300);
    });

    it("agrees with a plain JS Map with hash bits narrowed to the extreme (2 buckets)", () => {
      MapData._setHashBitsForTesting(1);
      runOracle(mulberry32(3), 1000, 50);
    });
  });
});
