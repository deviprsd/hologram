# credo:disable-for-this-file Credo.Check.Readability.Specs
defmodule Hologram.Test.Fixtures.Compiler.CallGraph.Module42 do
  use Hologram.ClientMFA

  @hologram_client_mfa my_fun: 1

  def my_fun(x), do: x
end
