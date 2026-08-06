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

Baseline before #878 stage 1 (identity short-circuit). `put/3` always calls
`Type.cloneMap` regardless of whether the value actually changed, so a no-op
write costs the same O(n) copy as a real one. After stage 1, this should drop
toward the cost of a single hashtable lookup and return the same map
reference.
