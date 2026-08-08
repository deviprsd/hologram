defmodule HologramFeatureTests.CompilerBugs.NewClauseNewCalleePage do
  use Hologram.Page

  # The compile-time noop_1..noop_27 clause names below are a fixed,
  # bounded 1..27 range, not runtime input - safe despite the check.
  # credo:disable-for-this-file Credo.Check.Warning.UnsafeToAtom

  import Hologram.Commons.KernelUtils, only: [inspect: 1]
  import Kernel, except: [inspect: 1]

  alias HologramFeatureTests.CompilerBugs.NewClauseNewCalleeHelper

  # Repro for https://github.com/deviprsd/hologram/issues/14: a many-clause
  # `action/3` (same ~30-clause shape as issue #9's MixedAsyncPage, matching
  # the real `Holoprint.Workspace.action/3` this was found in) where ONE
  # clause's only job is a single literal remote call to a BRAND-NEW
  # function with no other caller anywhere. Deliberately NO Task.await
  # anywhere in this page - issue #14 is not the async/state-race mechanism
  # #9 already covers, it reproduces with a purely synchronous clause.
  route "/compiler-bugs/new-clause-new-callee"

  layout HologramFeatureTests.Components.DefaultLayout

  def init(_params, component, _server) do
    put_state(component, :result, nil)
  end

  def template do
    ~HOLO"""
    <button id="run_btn" $click="brand_new_action"> Run </button>
    <p>
      Result: <strong id="result"><code>{inspect(@result)}</code></strong>
    </p>
    """
  end

  for n <- 1..27 do
    action_name = :"noop_#{n}"

    def action(unquote(action_name), _params, component) do
      component
    end
  end

  # If issue #14 reproduces, `NewClauseNewCalleeHelper.compute/0` is
  # silently pruned from the client bundle despite this being a fully
  # literal call - clicking #run_btn throws `UndefinedFunctionError`
  # client-side and `#result` stays "nil" instead of becoming "42".
  def action(:brand_new_action, _params, component) do
    put_state(component, :result, NewClauseNewCalleeHelper.compute())
  end
end
