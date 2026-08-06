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

Baseline before #878. `transformer.ex` compiles `%{m | k: v}` to `Map.merge/2`,
which today spreads both operands into a fresh object
(`{...map1.data, ...map2.data}`) - a full copy of the 20-key map to change one
key. This is the single hottest structural copy in the framework: it runs
once per `put_state` action and twice more per stateful component per render
(props+state, context+emitted_context in renderer.mjs).
