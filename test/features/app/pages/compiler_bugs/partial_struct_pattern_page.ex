defmodule HologramFeatureTests.CompilerBugs.PartialStructPatternPage do
  use Hologram.Page

  import Hologram.Commons.KernelUtils, only: [inspect: 1]
  import Kernel, except: [inspect: 1]

  defmodule Item do
    defstruct [:kind, :value]
  end

  # Repro for https://github.com/deviprsd/hologram/issues/12: a `case`
  # matching only SOME of a struct's fields - `%Item{kind: :data, value: v}`,
  # not every field - compiles clean, passes any BEAM test, and (per the
  # issue) crashes Hologram's client-side pattern matcher. `item` is a real
  # `%Item{}` struct built server-side at `init/3`, held in state exactly
  # like `Holoprint.Workspace`'s `RowEntry` structs are (read out of a cache,
  # not freshly literal-constructed at the match site).
  route "/compiler-bugs/partial-struct-pattern"

  layout HologramFeatureTests.Components.DefaultLayout

  def init(_params, component, _server) do
    component
    |> put_state(:item, %Item{kind: :data, value: 42})
    |> put_state(:result, nil)
  end

  def template do
    ~HOLO"""
    <button id="run_btn" $click="run"> Run </button>
    <p>
      Result: <strong id="result"><code>{inspect(@result)}</code></strong>
    </p>
    """
  end

  # If issue #12 reproduces, this action aborts silently client-side before
  # `put_state(:result, ...)` ever runs - `#result` stays "nil" after
  # clicking, instead of becoming "42".
  def action(:run, _params, component) do
    result =
      case component.state.item do
        %Item{kind: :data, value: v} -> v
        _ -> :no_match
      end

    put_state(component, :result, result)
  end
end
