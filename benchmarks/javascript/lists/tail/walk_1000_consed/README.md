Benchmark

Function: Erlang["tl/1"]\
Argument: walking a 1000-element list down to `[]`, one `tl/1` step at a time - list built by 1000 repeated `Interpreter.consOperator` calls (what transpiled `[h | t]` construction actually does), not a single array literal

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

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>257.67 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>4.83 μs</td>
  </tr>
</table>

This is the realistic shape `../walk_1000` was meant to measure and didn't:
a list actually built by recursive `[h | t]` consing (the classic
`process([h | t], acc)` accumulator pattern), then walked back down.
`erlang:tl/1` now returns the cons cell's own `.tail` field directly
(`erlang.mjs`) instead of `list.data.slice(1)`, so each step is O(1) and the
whole walk is O(n) - 4.83 μs warm here versus 120.66 μs for the same 1000
elements in `../walk_1000`'s packed-array case, a ~25x drop.
