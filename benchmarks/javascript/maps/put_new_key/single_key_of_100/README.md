Benchmark

Function: Erlang_Maps["put/3"]\
Argument: a 100-key map, putting a genuinely new key

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
    <td>76.83 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>15.04 μs</td>
  </tr>
</table>

Baseline before #878 stage 3 (HAMT). This one must always allocate - it's the
control for `put_no_op` above. Unlike that case, this cost should stay
roughly flat (O(log32 n)) rather than drop toward zero once the trie lands;
what changes is that it stops scaling with map size the way `Type.cloneMap`'s
full shallow copy does today.
