"use strict";

// #878 (structural sharing): a persistent hash array mapped trie (HAMT).
// Backs Type's boxed maps - see type.mjs. Deliberately generic and
// standalone: no knowledge of boxed Elixir terms, no imports. `key` is any
// string (Type will pass Type.encodeMapKey(term) results); `value` is an
// opaque payload MapData never inspects (Type stores [keyTerm, valueTerm]
// pairs there, matching the existing map.data pair-array convention so
// every downstream consumer's expectations survive unchanged).
//
// Standard 32-way (5 bits/level) HAMT: put/remove copy only the O(log32 n)
// nodes on the changed path, sharing every other subtree with the previous
// root. Not wired into Type yet - see map_data_test.mjs for the randomized
// oracle test this is verified against before anything imports it.
//
// Node shapes (private - never exposed outside this module):
//   null                          - empty subtree
//   {h, k, v, s}                  - leaf: one entry (hash, key, value, seq)
//   {h, ls: [leaf, ...]}          - collision: 2+ entries, same (possibly
//                                    hash-bit-limited) hash, different keys
//   {bm, ch: [node, ...]}         - bitmap-indexed node: bm's set bits mark
//                                    which of the 32 slots at this level are
//                                    occupied; ch holds only those children,
//                                    compacted (no empty-slot gaps)
//
// `s` (seq) is a monotonic insertion index, assigned once per key on first
// insert and preserved across value updates - see insert() - so
// MapData.entries() can reproduce plain-object insertion-order semantics
// (the same guarantee Type.map()'s old {} reduce gave for free) without the
// trie itself being ordered.

const BITS_PER_LEVEL = 5;
const LEVEL_MASK = (1 << BITS_PER_LEVEL) - 1;

// Test-only knob (see _setHashBitsForTesting below): narrows how many hash
// bits are actually consulted before a genuine key difference is forced
// into a collision node, so the oracle test can make collisions common with
// a handful of random keys instead of reverse-engineering real 32-bit ones.
let activeHashBits = 32;

let seqCounter = 0;

function nextSeq() {
  return seqCounter++;
}

function maxDepth() {
  return Math.ceil(activeHashBits / BITS_PER_LEVEL);
}

// FNV-1a, 32-bit.
function hashString(str) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < str.length; ++i) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function maskedHash(key) {
  const full = hashString(key);

  if (activeHashBits >= 32) {
    return full;
  }

  return full & ((1 << activeHashBits) - 1);
}

function popcount(x) {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;

  return (x * 0x01010101) >> 24;
}

function isLeaf(node) {
  return node !== null && node.k !== undefined;
}

function isCollision(node) {
  return node !== null && node.ls !== undefined;
}

function findLeaf(root, hash, key, depth) {
  if (root === null) {
    return undefined;
  }

  if (isLeaf(root)) {
    return root.h === hash && root.k === key ? root : undefined;
  }

  if (isCollision(root)) {
    return root.h === hash ? root.ls.find((leaf) => leaf.k === key) : undefined;
  }

  const bit = 1 << ((hash >>> (depth * BITS_PER_LEVEL)) & LEVEL_MASK);

  if ((root.bm & bit) === 0) {
    return undefined;
  }

  const idx = popcount(root.bm & (bit - 1));

  return findLeaf(root.ch[idx], hash, key, depth + 1);
}

// Builds the subtree separating two leaves whose hashes differ, agreeing on
// every bit consulted so far (depth levels). Recurses one level at a time;
// each step either finds the first level the two hashes disagree on (and
// stops with a proper 2-child bitmap node) or, if they still agree, wraps a
// single-child bitmap node and goes a level deeper. If hash bits run out
// (both leaves masked identically all the way down - only reachable when
// activeHashBits has been narrowed for testing, or on a genuine 32-bit
// collision), the two are grouped into a collision node instead.
function splitLeaves(leafA, leafB, depth) {
  if (depth >= maxDepth()) {
    return {h: leafA.h, ls: [leafA, leafB]};
  }

  const bitPosA = (leafA.h >>> (depth * BITS_PER_LEVEL)) & LEVEL_MASK;
  const bitPosB = (leafB.h >>> (depth * BITS_PER_LEVEL)) & LEVEL_MASK;

  if (bitPosA === bitPosB) {
    return {bm: 1 << bitPosA, ch: [splitLeaves(leafA, leafB, depth + 1)]};
  }

  const bm = (1 << bitPosA) | (1 << bitPosB);

  return {bm, ch: bitPosA < bitPosB ? [leafA, leafB] : [leafB, leafA]};
}

// `seq` is resolved by the caller (MapData.put) before calling this, so a
// value-only update on an existing key reuses that key's original seq
// rather than being treated as a fresh insert - see the module doc.
function insert(root, hash, key, value, seq, depth) {
  const newLeaf = {h: hash, k: key, v: value, s: seq};

  if (root === null) {
    return newLeaf;
  }

  if (isLeaf(root)) {
    if (root.h === hash && root.k === key) {
      return newLeaf;
    }

    if (root.h === hash) {
      return {h: hash, ls: [root, newLeaf]};
    }

    return splitLeaves(root, newLeaf, depth);
  }

  if (isCollision(root)) {
    if (root.h !== hash) {
      // A genuinely different hash reaching a collision node only happens
      // if depth < maxDepth (a collision node normally only exists at
      // maxDepth) - defensive, not expected to be exercised, but correct
      // regardless: fold the whole collision group back through
      // splitLeaves against the new leaf, pairwise.
      return root.ls.reduce(
        (acc, leaf) => insert(acc, leaf.h, leaf.k, leaf.v, leaf.s, depth),
        newLeaf,
      );
    }

    const idx = root.ls.findIndex((leaf) => leaf.k === key);
    const newLeaves = root.ls.slice();

    if (idx === -1) {
      newLeaves.push(newLeaf);
    } else {
      newLeaves[idx] = newLeaf;
    }

    return {h: hash, ls: newLeaves};
  }

  // Bitmap node.
  const bitPos = (hash >>> (depth * BITS_PER_LEVEL)) & LEVEL_MASK;
  const bit = 1 << bitPos;
  const idx = popcount(root.bm & (bit - 1));

  if ((root.bm & bit) === 0) {
    const newChildren = root.ch.slice();
    newChildren.splice(idx, 0, newLeaf);

    return {bm: root.bm | bit, ch: newChildren};
  }

  const newChildren = root.ch.slice();
  newChildren[idx] = insert(root.ch[idx], hash, key, value, seq, depth + 1);

  return {bm: root.bm, ch: newChildren};
}

// Simpler than a maximally-compacting HAMT delete: doesn't collapse
// single-child bitmap nodes left behind by a removal back into a bare leaf.
// That's a real trie shallowness optimization this gives up, not a
// correctness gap - every get/put/remove/entries call below is unaffected,
// it's purely about how many nodes get copied on the next update through an
// under-compacted path. Deliberate simplification given how easy that
// collapsing logic is to get subtly wrong; can be revisited later against
// the oracle test if profiling ever shows it matters.
function removeAt(root, hash, key, depth) {
  if (root === null) {
    return null;
  }

  if (isLeaf(root)) {
    return root.h === hash && root.k === key ? null : root;
  }

  if (isCollision(root)) {
    if (root.h !== hash) {
      return root;
    }

    const newLeaves = root.ls.filter((leaf) => leaf.k !== key);

    if (newLeaves.length === root.ls.length) {
      return root;
    }

    return newLeaves.length === 1 ? newLeaves[0] : {h: hash, ls: newLeaves};
  }

  // Bitmap node.
  const bitPos = (hash >>> (depth * BITS_PER_LEVEL)) & LEVEL_MASK;
  const bit = 1 << bitPos;

  if ((root.bm & bit) === 0) {
    return root;
  }

  const idx = popcount(root.bm & (bit - 1));
  const newChild = removeAt(root.ch[idx], hash, key, depth + 1);

  if (newChild === root.ch[idx]) {
    return root;
  }

  if (newChild === null) {
    if (root.ch.length === 1) {
      return null;
    }

    const newChildren = root.ch.slice();
    newChildren.splice(idx, 1);

    return {bm: root.bm & ~bit, ch: newChildren};
  }

  const newChildren = root.ch.slice();
  newChildren[idx] = newChild;

  return {bm: root.bm, ch: newChildren};
}

function collectLeaves(root, acc) {
  if (root === null) {
    return acc;
  }

  if (isLeaf(root)) {
    acc.push(root);
    return acc;
  }

  if (isCollision(root)) {
    acc.push(...root.ls);
    return acc;
  }

  for (const child of root.ch) {
    collectLeaves(child, acc);
  }

  return acc;
}

const MapData = {
  EMPTY: null,

  get(root, key) {
    const leaf = findLeaf(root, maskedHash(key), key, 0);

    return leaf === undefined ? undefined : leaf.v;
  },

  has(root, key) {
    return findLeaf(root, maskedHash(key), key, 0) !== undefined;
  },

  // Returns {root, added}. `added` is false (and `root` is the same
  // reference as the input) for a value-only update on an already-present
  // key OR when nothing about the key/value pair is new - callers that want
  // an identity short-circuit on an unchanged *value* (see maps:put/3's
  // reference-identity no-op check, #878 stage 1) still need to do that
  // check themselves before calling put; this always writes.
  put(root, key, value) {
    const hash = maskedHash(key);
    const existing = findLeaf(root, hash, key, 0);
    const seq = existing === undefined ? nextSeq() : existing.s;
    const newRoot = insert(root, hash, key, value, seq, 0);

    return {root: newRoot, added: existing === undefined};
  },

  // Returns {root, removed}.
  remove(root, key) {
    const hash = maskedHash(key);

    if (findLeaf(root, hash, key, 0) === undefined) {
      return {root, removed: false};
    }

    return {root: removeAt(root, hash, key, 0), removed: true};
  },

  // [[key, value], ...] in insertion order (first-occurrence position, last-
  // write value - the same semantics a plain {} object literal with
  // duplicate keys has always given Type.map()).
  entries(root) {
    const leaves = collectLeaves(root, []);
    leaves.sort((a, b) => a.s - b.s);

    return leaves.map((leaf) => [leaf.k, leaf.v]);
  },

  // O(n) bulk build from [[key, value], ...] - one pass, not N sequential
  // path-copies. Duplicate keys: last value wins, first occurrence's
  // position wins (see put()'s seq-reuse), matching entries()'s contract.
  fromEntries(pairs) {
    let root = null;
    let size = 0;

    for (const [key, value] of pairs) {
      const result = MapData.put(root, key, value);
      root = result.root;

      if (result.added) {
        ++size;
      }
    }

    return {root, size};
  },

  // O(n) - for tests/debugging only. Real callers track size incrementally
  // via put()/remove()'s added/removed flags.
  sizeSlow(root) {
    return collectLeaves(root, []).length;
  },

  // Test-only. See the activeHashBits doc comment above.
  _setHashBitsForTesting(bits) {
    activeHashBits = bits;
  },

  _resetHashBitsForTesting() {
    activeHashBits = 32;
  },
};

export default MapData;
