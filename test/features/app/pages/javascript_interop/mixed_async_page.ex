defmodule HologramFeatureTests.JavaScriptInterop.MixedAsyncPage do
  use Hologram.Page
  use Hologram.JS

  # The compile-time noop_1..noop_27 clause names below are a fixed,
  # bounded 1..27 range, not runtime input - safe despite the check.
  # credo:disable-for-this-file Credo.Check.Warning.UnsafeToAtom

  import Hologram.Commons.KernelUtils, only: [inspect: 1]
  import Kernel, except: [inspect: 1]

  js_import from: "./helpers.mjs", as: :helpers

  route "/js-interop/mixed-async"

  layout HologramFeatureTests.Components.DefaultLayout

  def init(_params, component, _server) do
    component
    |> put_state(:count, 0)
    |> put_state(:result, nil)
  end

  def template do
    ~HOLO"""
    <p>
      <button id="bump_sync_btn" $click="bump_sync"> Bump sync </button>
    </p>
    <p>
      <button id="bump_many_btn" $click="bump_sync_30x"> Bump sync 30x </button>
    </p>
    <p>
      <button $click="do_async"> Do async </button>
    </p>
    <p>
      Count: <strong id="count_result"><code>{inspect(@count)}</code></strong>
    </p>
    <p>
      Call result: <strong id="call_result"><code>{inspect(@result)}</code></strong>
    </p>
    """
  end

  # ~30 unrelated sync no-op clauses, matching Holoprint.Workspace.action/3's
  # real clause count from https://github.com/deviprsd/hologram/issues/9.
  # Verified this race also reproduces with just 2 total clauses (:bump_sync
  # + :do_async) - clause count doesn't matter, included here only to mirror
  # the original report's shape.
  for n <- 1..27 do
    action_name = :"noop_#{n}"

    def action(unquote(action_name), _params, component) do
      component
    end
  end

  # This clause never touches Task.await/1 - it's a plain synchronous action.
  def action(:bump_sync, _params, component) do
    put_state(component, :count, component.state.count + 1)
  end

  # Fires 30 real native click events on the bump button in a tight
  # synchronous loop - no setTimeout, no await between dispatches. This is
  # the actual DOM event path ($click, delay 0) that a rapid ArrowDown
  # key-repeat burst goes through, unlike Hologram.dispatchAction (which
  # is serialized through scheduleAction's setTimeout).
  def action(:bump_sync_30x, _params, component) do
    ~JS"""
    const btn = document.getElementById("bump_sync_btn");
    for (let i = 0; i < 30; i++) {
      btn.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    }
    """

    component
  end

  # Sibling clause of the same action/3 - its mere presence (reachable via the
  # call graph, whether or not it is ever invoked) marks the whole action/3
  # MFA as async, per Hologram issue #9.
  def action(:do_async, _params, component) do
    result =
      :helpers
      |> JS.call(:asyncSum, [1, 2])
      |> Task.await()

    put_state(component, :result, result)
  end
end
