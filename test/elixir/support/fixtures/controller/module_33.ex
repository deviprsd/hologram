# A page with an optional trailing route param (deviprsd#32).
defmodule Hologram.Test.Fixtures.Controller.Module33 do
  use Hologram.Page

  route "/hologram-test-fixtures-controller-module33/:aaa?"

  param :aaa, :string

  layout Hologram.Test.Fixtures.LayoutFixture

  @impl Page
  def template do
    ~HOLO"""
    param_aaa = {inspect(@aaa)}
    """
  end
end
