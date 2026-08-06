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

Before #878 stage 1:

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

After stage 1 (incl. interning `Type.nil()` - see below):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>73.54 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>3.01 μs</td>
  </tr>
</table>

After stage 3 (HAMT wired into Type.map):

<table>
  <tr>
    <th>Average Cold Execution Time</th>
    <td>119.58 μs</td>
  </tr>
  <tr>
    <th>Average Warm Execution Time</th>
    <td>3.03 μs</td>
  </tr>
</table>

End-to-end shape of the four map copies one `put_state/3` action costs today
(state put, struct merge, nil next_action put, nil next_command put - see
run.mjs for the full breakdown with source line references). Only a small
drop so far: 2 of the 4 ops are genuine value changes (the state put and the
struct merge), which stage 1 can't help with - that's the O(n) HAMT-copy cost
stage 3 targets. The other 2 (the nil `next_action`/`next_command` puts) are
no-ops in the overwhelmingly common case and now hit put/3's fast path -
verified directly by checking `savedComponentStruct === resultComponentStruct`
after both puts when the incoming struct is already all-nil there, not
inferred from this benchmark's timing.

Getting that no-op to actually fire needed one more piece not in the original
plan text: `hologram.mjs` calls `Type.nil()` fresh on every
`#processActionResult` (real code, not a benchmark artifact - see
hologram.mjs ~line 1166/1172), and `Type.atom()` doesn't intern, so two
separately-constructed `nil` atoms were never reference-equal and the put/3
identity check could never see them as a no-op. Fixed by interning
`Type.nil()` to a module-level singleton (`type.mjs`) - safe because nothing
in the runtime compares atoms by reference or mutates a boxed atom in place;
every other equality check already goes by `.value`. This is exactly the gap
stage 5's "next_action/next_command stop allocating on the already-nil path"
goal depends on, so it's pulled into stage 1 rather than left implicit.

Stage 3's total is flat versus stage 1 (3.03 μs vs. 3.01 μs) even though the
underlying map put/merge ops the trie targets did improve individually (see
`maps/put_new_key` and `maps/merge/single_key_into_20`) - both showed their
biggest gains on maps around 20-100 keys, but the complexity-class win
(O(n) -> O(log32 n)) is small in absolute terms at those sizes, same as
`maps/merge/single_key_into_20`'s own note about its modest drop; and the two
no-op puts, whose stage-1 win already accounted for most of this composite
number's improvement, get very slightly *more* expensive on a trie (see
`maps/put_no_op`'s own stage 3 entry) - the two effects roughly cancel out
here. The complexity-class win is real and shows up directly in the
isolated map benchmarks; this end-to-end number just isn't the right place
to see it at this struct/state size.
