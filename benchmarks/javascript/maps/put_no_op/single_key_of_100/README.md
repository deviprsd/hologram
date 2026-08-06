Benchmark

Function: Erlang_Maps["put/3"]\
Argument: a 100-key map, putting an existing key back with its current (reference-identical) value - a no-op write

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

Before #878 stage 1 (identity short-circuit):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>79.33 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>13.09 μs</td>
  </tr>
</table>

After stage 1:

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>21.88 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>0.23 μs</td>
  </tr>
</table>

`put/3` used to always call `Type.cloneMap` regardless of whether the value
actually changed, so a no-op write cost the same O(n) copy as a real one.
Stage 1 adds a reference-identity check before the clone: 0.23 μs warm is a
~57x drop, matching the expected O(1) hashtable lookup replacing an O(n)
shallow copy - and the returned map is now `===` the input, verified directly
(not just inferred from timing).

Note: getting a real measurement here required reusing the exact value
object already stored under the key rather than constructing a fresh
equal-value term - the latter is not reference-identical, so it silently
falls through to the full copy and would have hidden the fast path entirely.
