defmodule HologramFeatureTests.JavaScriptInterop.SyncOnlyControlPage do
  use Hologram.Page
  use Hologram.JS

  # The compile-time noop_1..noop_27 clause names below are a fixed,
  # bounded 1..27 range, not runtime input - safe despite the check.
  # credo:disable-for-this-file Credo.Check.Warning.UnsafeToAtom

  import Hologram.Commons.KernelUtils, only: [inspect: 1]
  import Kernel, except: [inspect: 1]

  route "/js-interop/sync-only-control"

  layout HologramFeatureTests.Components.DefaultLayout

  def init(_params, component, _server) do
    put_state(component, :count, 0)
  end

  def template do
    ~HOLO"""
    <p>
      <button id="bump_sync_btn" $click="bump_sync"> Bump sync </button>
    </p>
    <p>
      Count: <strong id="count_result"><code>{inspect(@count)}</code></strong>
    </p>
    """
  end

  # ~30 unrelated sync no-op clauses, matching Holoprint.Workspace.action/3's
  # real clause count - same shape as MixedAsyncPage, minus any Task.await
  # sibling. Control for https://github.com/deviprsd/hologram/issues/9.
  for n <- 1..27 do
    action_name = :"noop_#{n}"

    def action(unquote(action_name), _params, component) do
      component
    end
  end

  def action(:bump_sync, _params, component) do
    put_state(component, :count, component.state.count + 1)
  end
end
