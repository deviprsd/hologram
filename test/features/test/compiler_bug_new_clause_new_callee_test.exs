defmodule HologramFeatureTests.CompilerBugNewClauseNewCalleeTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.CompilerBugs.NewClauseNewCalleePage

  # Repro for https://github.com/deviprsd/hologram/issues/14.
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
