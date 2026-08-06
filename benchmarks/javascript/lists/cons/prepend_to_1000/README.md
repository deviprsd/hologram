Benchmark

Function: Interpreter.consOperator()\
Argument: a single `[h | t]` cons where `t` is a 1000-element proper list

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

Before #878 stage 4 (cons cells):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>24.54 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>1.10 μs</td>
  </tr>
</table>

After stage 4:

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>36.75 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>0.19 μs</td>
  </tr>
</table>

`consOperator` used to be `Type.list([head].concat(tail.data))` - an O(n)
array copy per cons. It now shares the tail via a cons cell instead
(`Type.cons`, `type.mjs`) - 0.19 μs warm is a ~5.8x drop and no longer
depends on the tail's length, verified directly (`result.tail === tail`) in
`interpreter_test.mjs`, not just inferred from timing. Compare against
`lists/tail/walk_1000_consed`, which shows the compounding effect of this
cost dropping out of a loop that repeatedly walks a consed list.

Re-measured after #878 stage 3 (the map HAMT wiring, unrelated to lists):
0.21 μs warm, flat within noise, as expected - cons cells don't touch
`Type.map`/`map_data.mjs` at all.
