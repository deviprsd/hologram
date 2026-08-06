Benchmark

Function: Erlang["tl/1"]\
Argument: walking a 1000-element proper list down to `[]` one `tl/1` step at a time

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
    <td>678.00 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>114.23 μs</td>
  </tr>
</table>

This is the O(n^2) case: `tl/1` bottoms out in `Interpreter.#listRemainder`,
which is `list.data.slice(fromIndex)` - an O(n) array copy per step, so
walking the whole list is O(n^2). At 114.23 μs warm for 1000 elements this
is already ~100x the single-cons cost in `lists/cons/prepend_to_1000`
(1.10 μs), and the gap widens quadratically with list length.

**This number is an intentional control, not a regression to fix**: the list
here is a single `Type.list(array)` literal, a packed list with no cons
cells in it to walk lazily - after stage 4 it measures 120.66 μs, unchanged
within noise, because there's nothing for the cons-cell work to speed up.
See `../walk_1000_consed` for the shape #878 actually targets (a list built
by repeated consing, matching how transpiled `[h | t]` construction really
produces one) - same 1000 elements, same walk, 4.83 μs warm, a ~25x drop.
