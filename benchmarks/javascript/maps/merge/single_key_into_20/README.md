Benchmark

Function: Erlang_Maps["merge/2"]\
Argument: a 20-key state map, merged with a 1-key map - the shape of every `%{m | k: v}` update

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

Before #878 stage 1:

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>27.13 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>2.18 μs</td>
  </tr>
</table>

After stage 1 (this case is a real value change, not a no-op merge - see
below):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>39.13 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>2.72 μs</td>
  </tr>
</table>

After stage 3 (HAMT wired into Type.map, via Type.mapMerge):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>84.46 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>1.42 μs</td>
  </tr>
</table>

`transformer.ex` compiles `%{m | k: v}` to `Map.merge/2`, which today spreads
both operands into a fresh object (`{...map1.data, ...map2.data}`) - a full
copy of the 20-key map to change one key. This is the single hottest
structural copy in the framework: it runs once per `put_state` action and
twice more per stateful component per render (props+state,
context+emitted_context in renderer.mjs).

This benchmark deliberately puts in a _changed_ value, so stage 1's identity
short-circuit can't skip the copy here and the small increase above is the
added no-op check paying for itself on the path that doesn't benefit -
expected and within noise at this scale. The short-circuit itself is verified
directly (not benchmarked, since a no-op has near-zero cost to measure
meaningfully): merging an empty map is `===` the non-empty operand in either
direction, and merging in a value that's already reference-identical returns
the original map unchanged.

Stage 3 replaces `{...map1.data, ...map2.data}`'s full O(n) spread copy with
`Type.mapMerge`'s O(size(map2) * log32 size(map1)) path-copy - map2 here is
the 1-key change, so this is one small trie descent into map1's 20-key trie.
1.42 μs warm is a ~1.9x drop from stage 1's 2.72 μs. That is a modest
absolute win at n=20 (a 20-key object spread is already fast; log32(20) is
barely more than one level, so there isn't much O(n) to shed yet) - the
complexity-class change matters far more as component state maps grow past
this benchmark's size, which this single fixed-size number doesn't show on
its own.
