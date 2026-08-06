Benchmark

Function: ComponentRegistry.putComponentStruct()\
Argument: a 30-live-component registry, writing a genuinely new struct (not a no-op) to one of them

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
    <td>39.54 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>2.63 μs</td>
  </tr>
</table>

`putComponentStruct`/`putEntry` used to mutate `ComponentRegistry.entries.data`
in place - a pattern an immutable trie-backed map can't support (see #878's
`map_data.mjs`), so they now write through `Erlang_Maps["put/3"]` instead.
Until the trie is wired into `Type.map`, that costs a full clone of the
whole `entries` registry (`Type.cloneMap`, O(n) in live component count) per
struct write, not a path-copy of just the changed cid.

2.63 μs on a 30-component registry is the answer to "does that clone cost
matter before the trie lands": no, it's noise at real component counts -
same order of magnitude as `maps/merge/single_key_into_20` (2.72 μs for an
unrelated 20-key merge). Re-run this after the trie is wired in to confirm
the expected O(n) -> O(log32 n) drop, and as a regression check if it
doesn't materialize.
