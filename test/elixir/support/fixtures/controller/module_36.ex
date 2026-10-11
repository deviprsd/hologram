# A page with an optional trailing route param (deviprsd#32).
defmodule Hologram.Test.Fixtures.Controller.Module36 do
  use Hologram.Page

  route "/hologram-test-fixtures-controller-module36/:aaa?"

  param :aaa, :string

  layout Hologram.Test.Fixtures.LayoutFixture

  @impl Page
  def template do
    ~HOLO"""
    param_aaa = {inspect(@aaa)}
    """
  end
end
