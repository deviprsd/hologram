defmodule HologramFeatureTests.MixedAsyncTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.JavaScriptInterop.MixedAsyncPage
  alias HologramFeatureTests.JavaScriptInterop.SyncOnlyControlPage

  # Regression test for https://github.com/deviprsd/hologram/issues/9 /
  # bartblast/hologram#1002: a Task.await-resolving sibling clause used to
  # corrupt an unrelated, purely synchronous clause in the same multi-clause
  # action/3 under rapid dispatch. Fixed by ComponentRegistry.runExclusive().
  feature "sync clause of a mixed sync/async action/3 still runs synchronously", %{
    session: session
  } do
    session
    |> visit(MixedAsyncPage)
    |> click(css("#bump_sync_btn"))
    |> assert_text(css("#count_result"), "1")
  end

  feature "30 rapid-fire sync dispatches all land, like 30 ArrowDown presses", %{
    session: session
  } do
    session = visit(session, MixedAsyncPage)

    Wallaby.Browser.execute_script(session, """
    const btn = document.getElementById("bump_sync_btn");
    for (let i = 0; i < 30; i++) {
      btn.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    }
    """)

    session
    |> assert_text(css("#count_result"), "30")
  end

  # Control: identical shape (30 clauses, same dispatch pattern), minus any
  # Task.await sibling anywhere in action/3. Passes regardless of the fix -
  # confirms the async sibling clause, not clause count or dispatch pattern,
  # was ever the trigger.
  feature "control: same 30x dispatch on a purely-sync action/3 lands all 30", %{
    session: session
  } do
    session = visit(session, SyncOnlyControlPage)

    Wallaby.Browser.execute_script(session, """
    const btn = document.getElementById("bump_sync_btn");
    for (let i = 0; i < 30; i++) {
      btn.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    }
    """)

    session
    |> assert_text(css("#count_result"), "30")
  end
end
