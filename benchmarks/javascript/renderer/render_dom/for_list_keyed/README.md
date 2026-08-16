Benchmark

Function: Renderer.renderDom()\
Argument: a 30-row `<ul>` list, each `<li>` carrying a "$key" attribute (see
Hologram.Template.DOM.add_slot_keys/2 and Renderer.#renderSlotKey) - compare against
for_list_unkeyed for the per-item key-processing overhead

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
    <td>29.0.1</td>
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
    <td>886 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>30.8 μs</td>
  </tr>
</table>

About 15% over the unkeyed baseline's warm time - the cost of reading each row's "$key" attribute
and snabbdom's keyed diffing. Since positional/identity keys attach directly to their element
rather than wrapping it in marker comments, node count no longer differs between the two
benchmarks at all (previously the keyed case rendered 3 nodes per row against the unkeyed case's
1, for a roughly 2x gap).
