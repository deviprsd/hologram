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

Baseline before #878 stage 4 (cons cells). `consOperator` is
`Type.list([head].concat(tail.data))` - an O(n) array copy per cons. Compare
against `lists/tail/walk_1000`, which shows what happens when this cost is
paid repeatedly in a loop. After stage 4, a single cons should cost O(1)
regardless of the tail's length.
