defmodule HologramFeatureTests.ModuleFixture3 do
  use Hologram.ClientMFA

  @hologram_client_mfa is_integer: 1, reverse: 1

  def is_integer(term), do: Kernel.is_integer(term)

  def reverse(list), do: Enum.reverse(list)
end
