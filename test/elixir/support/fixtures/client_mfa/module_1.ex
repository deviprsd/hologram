# credo:disable-for-this-file Credo.Check.Readability.Specs
defmodule Hologram.Test.Fixtures.ClientMFA.Module1 do
  use Hologram.ClientMFA

  @hologram_client_mfa foo: 1
  @hologram_client_mfa bar: 2, baz: 0

  def foo(x), do: x
  def bar(x, y), do: {x, y}
  def baz, do: :baz
end
