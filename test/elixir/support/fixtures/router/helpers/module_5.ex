# A page with a chain of two trailing optional route params (deviprsd#32).
defmodule Hologram.Test.Fixtures.Router.Helpers.Module5 do
  use Hologram.Page

  route "/hologram-test-fixtures-router-helpers-module5/:id?/:panel?"

  param :id, :string
  param :panel, :string

  layout Hologram.Test.Fixtures.LayoutFixture

  @impl Page
  def template, do: ~HOLO""
end
