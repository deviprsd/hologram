# A page with a chain of two trailing optional route params (deviprsd#32).
defmodule Hologram.Test.Fixtures.Controller.Module34 do
  use Hologram.Page

  route "/hologram-test-fixtures-controller-module34/:id?/:panel?"

  param :id, :string
  param :panel, :string

  layout Hologram.Test.Fixtures.LayoutFixture

  @impl Page
  def template do
    ~HOLO"""
    param_id = {inspect(@id)}, param_panel = {inspect(@panel)}
    """
  end
end
