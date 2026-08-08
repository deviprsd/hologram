defmodule HologramFeatureTests.CompilerBugPartialStructPatternTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.CompilerBugs.PartialStructPatternPage

  # Repro for https://github.com/deviprsd/hologram/issues/12.
  #
  # Expected result if the issue reproduces: this assertion FAILS - the
  # client-side action aborts inside the partial-field struct pattern match
  # before put_state/3 ever runs, so #result stays "nil" instead of
  # becoming "42". A passing run means either the bug is fixed, or (worth
  # checking) the pinned upstream commit doesn't exhibit it - see the
  # issue for the mechanism this is isolating.
  feature "case with a partial-field struct pattern still resolves the match client-side", %{
    session: session
  } do
    session
    |> visit(PartialStructPatternPage)
    |> click(css("#run_btn"))
    |> assert_text(css("#result"), "42")
  end
end
