defmodule HologramFeatureTests.CompilerBugs.NewClauseNewCalleeHelper do
  @moduledoc """
  Brand-new module with no caller anywhere except one brand-new `action/3`
  clause on `NewClauseNewCalleePage` - see that page's own moduledoc, repro
  for https://github.com/deviprsd/hologram/issues/14. `compute/0` itself
  calls a second brand-new private function, matching the original report's
  shape (`Tree.children_batch_loaded/2` calling `single_result/1` and
  `redispatch_remaining/2`, both new in the same commit).
  """

  def compute, do: inner_compute()

  defp inner_compute, do: 42
end
