# A page with an optional trailing route param (deviprsd#32).
defmodule Hologram.Test.Fixtures.Router.Helpers.Module4 do
  use Hologram.Page

  route "/hologram-test-fixtures-router-helpers-module4/:param?"

  param :param, :string

  layout Hologram.Test.Fixtures.LayoutFixture

  @impl Page
  def template, do: ~HOLO""
end
