Benchmark

Function: Renderer.renderDom()\
Argument: a 30-row `<ul>` list, each row wrapped in an item marker pair (see
Hologram.Template.Marker.item_node/4) - compare against for_list_unkeyed for the per-item marker
overhead

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
    <td>1146.79 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>47.18 μs</td>
  </tr>
</table>

Roughly 2x the unkeyed baseline's warm time, tracking the node count: each row goes from one
`<li>` to three nodes (open marker, `<li>`, close marker).
