Benchmark

Function: ComponentRegistry.putComponentStruct()\
Argument: a 30-live-component registry, writing back the already-stored struct reference to one of them (a no-op)

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
    <td>18.67 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>0.74 μs</td>
  </tr>
</table>

Companion to `../put_component_struct_30_components`, which always writes a
genuinely different struct. This one writes back the exact struct object
already stored under the target cid - the shape an action that returns
unchanged state actually produces, since `maps:put/3`'s identity fast path
(stage 1) means the "new" struct handed to `putComponentStruct` after a
no-op state write is the same object already there, all the way through
`%{component | state: new_state}`'s `Map.merge/2`.

`putComponentStruct` (stage 5, `component_registry.mjs`) checks for exactly
this: if the incoming struct is `===` the one already stored, it skips both
the write and `RenderCache.markDirty` entirely - no trie path-copy, no
re-render for this cid or any ancestor whose descendant-dirtiness check
would otherwise trip on it. 0.74 μs warm versus the sibling benchmark's
5.64 μs for an always-changing struct is about a 7.6x difference - most of
that gap is the entire write + markDirty this case skips, not just a
cheaper version of it. Verified directly (not just inferred from timing) in
`component_registry_test.mjs`: `ComponentRegistry.entries` is the identical
object before and after the no-op call, and a `RenderCache.markDirty` spy is
asserted `notCalled`.
