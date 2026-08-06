Benchmark

Function: simulated `Hologram.#processActionResult` clone chain\
Argument: `put_state(component, :key, value)` on a 5-field component struct with a 20-key state map

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
    <td>56.88 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>3.17 μs</td>
  </tr>
</table>

Baseline before #878. End-to-end shape of the four map copies one
`put_state/3` action costs today (state put, struct merge, nil next_action
put, nil next_command put - see run.mjs for the full breakdown with source
line references). After stages 1/3/5, the two nil-field puts should become
no-ops on the overwhelmingly common already-nil path, and the struct merge
should path-copy only the changed key.
