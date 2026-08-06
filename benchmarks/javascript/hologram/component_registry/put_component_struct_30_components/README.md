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

Before #878 stage 3 (write-through to a plain-object map, O(n) clone per
write):

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

After stage 3 (HAMT wired into Type.map) + stage 5 (putComponentStruct's
reference-identity guard - see component_registry.mjs):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>62.38 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>5.64 μs</td>
  </tr>
</table>

`putComponentStruct`/`putEntry` used to mutate `ComponentRegistry.entries.data`
in place - a pattern an immutable trie-backed map can't support (see #878's
`map_data.mjs`), so they now write through `Erlang_Maps["put/3"]` instead.
Before the trie was wired in, that cost a full clone of the whole `entries`
registry (`Type.cloneMap`, O(n) in live component count) per struct write,
not a path-copy of just the changed cid; 2.63 μs on a 30-component registry
showed that cost didn't matter yet at realistic component counts.

**This benchmark got slower, not faster, and that is the expected, correctly
attributed result of stage 5's own change, not a regression to chase.**
`putComponentStruct` now reads the currently-stored struct first (an extra
`Erlang_Maps["get/3"]` trie descent) to check whether the incoming struct is
already reference-identical, so it can skip the write and
`RenderCache.markDirty` entirely on a no-op. This benchmark, by design (see
run.mjs), writes a genuinely different struct on every single call - the
one shape that guard can never pay for itself on, so 5.64 μs here is simply
that guard's fixed cost added on top of a real write that still has to
happen anyway. See `../put_component_struct_30_components_no_op` for the
case the guard exists for: the same 30-component registry, writing back the
already-stored struct reference, at 0.74 μs - about 7.6x cheaper than this
benchmark's always-changing case, and the actual #878 stage 5 payoff.
