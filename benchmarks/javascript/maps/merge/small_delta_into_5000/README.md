Benchmark

Function: Erlang_Maps["merge/2"]\
Argument: a 5000-key map, merged with a 2-key map of brand-new keys - the shape of `Holoprint.Workspace`'s `row_cache` accumulating chunks on every scroll (`Map.merge(row_cache, tupled_chunks)`), not `../single_key_into_20`'s fixed small map1

## System

<table>
  <tr>
    <th>Operating System</th>
    <td>macOS 26.5.1</td>
  </tr>
  <tr>
    <th>CPU</th>
    <td>Apple M2 Max</td>
  </tr>
  <tr>
    <th>Number of CPU Cores</th>
    <td>12</td>
  </tr>
  <tr>
    <th>RAM</th>
    <td>32 GB</td>
  </tr>
  <tr>
    <th>Elixir Version</th>
    <td>1.20.0</td>
  </tr>
  <tr>
    <th>Erlang/OTP Version</th>
    <td>29</td>
  </tr>
  <tr>
    <th>Node.js Version</th>
    <td>24.13.0</td>
  </tr>
</table>

## Statistics

Before this fix (`TrieMap._order` as a flat array, `map1._order.slice()` on every merge):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>158.00 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>7.25 μs</td>
  </tr>
</table>

After (`TrieMap._order` as a prepend-shared linked chain - see `type.mjs`):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>156.38 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>1.56 μs</td>
  </tr>
</table>

This benchmark exists because `maps/merge/single_key_into_20` never caught a
real bug: `Type.mapMerge` copied map1's *entire* insertion-order array on
every single call (`map1._order.slice()`), no matter how few keys map2
actually added. For a merge into a small, fixed 20-key map that's invisible
(20-element array copy is nothing) - but `row_cache` in Setu's
`Holoprint.Workspace` (a 10k-row virtualized grid) grows across every scroll
action via exactly this call, and the order-copy cost grew with it: live
against `/dev/holoprint/workspace`, `page rendered in` climbed from ~50ms
near an empty cache to 400+ms (and past a 45-second render freeze near a
full one) as `row_cache` accumulated - completely undoing the HAMT's
O(log32 n) per-write cost with an O(size(map1)) array copy bolted on
alongside it, on the one operation (`%{state | k: v}` merging a small delta
into a large map) merge/2 exists for.

Comparing this benchmark's 1.56 μs (5000-key map1) against
`../single_key_into_20`'s 1.42 μs (20-key map1) is the actual regression
check: a 250x difference in map1's size produces no meaningful difference in
merge cost, confirming the fix is genuinely O(size(map2) * log32 size(map1)),
not O(size(map1)). The pre-fix numbers above (7.25 μs, a ~4.6x cost even at
just 5000 keys) are kept here specifically so this exact bug shape can't
regress silently again - re-run after any future change to `TrieMap._order`
or `Type.mapMerge`.

Live re-validation against the same Setu workload after this fix is tracked
in the `f-878/structural-sharing` PR description.
