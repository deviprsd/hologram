defmodule HologramFeatureTests.CompilerBugNewClauseNewCalleeTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.CompilerBugs.NewClauseNewCalleePage

  # Repro for https://github.com/deviprsd/hologram/issues/14.
  #
  # STATUS (2026-08-08): PASSES on this minimal page - bug does NOT
  # reproduce, on fresh AND incremental builds (tested both: baseline
  # compile without the new clause/callee, then re-add and recompile
  # without wiping _build). The original finding (Setu app,
  # `Holoprint.Workspace.Tree.children_batch_loaded/2`) is unconfirmed as
  # to mechanism - untested structural differences from the real case:
  # Hologram.Component vs Hologram.Page context, ~35 real clauses vs 27
  # no-ops here, callee living in a brand-new module vs one with other
  # reachable functions, multiple new functions added across modules in
  # the same commit. See the issue #14 comment thread for the full writeup.
  #
  # Expected result if the issue reproduces: this assertion FAILS -
  # `NewClauseNewCalleeHelper.compute/0`'s own `defineElixirFunction` is
  # missing from the bundle even though the call site (inside this page's
  # brand-new `:brand_new_action` clause) compiled fine, so clicking
  # #run_btn throws `UndefinedFunctionError` client-side and #result stays
  # "nil" instead of becoming "42". Deliberately no Task.await anywhere in
  # this page - this is a distinct compile-time reachability gap from
  # issue #9's runtime state race, not a re-report of it.
  feature "a brand-new function reachable only via one brand-new action/3 clause still resolves",
          %{session: session} do
    session
    |> visit(NewClauseNewCalleePage)
    |> click(css("#run_btn"))
    |> assert_text(css("#result"), "42")
  end
end
