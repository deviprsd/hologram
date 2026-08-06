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

Before #878 stage 3 (HAMT):

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

After stage 3 (HAMT wired into Type.map):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>56.88 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>1.18 μs</td>
  </tr>
</table>

This one must always allocate - it's the control for `put_no_op` above,
which can skip the write entirely. 1.18 μs warm is a ~12.7x drop from
`Type.cloneMap`'s O(n) shallow copy of the whole 100-key hashtable object to
`Type.mapPut`'s O(log32 n) path-copy of only the trie nodes on the changed
path - a complexity-class change, not just a constant-factor one, so unlike
the pre-HAMT number this stops scaling linearly with map size.
