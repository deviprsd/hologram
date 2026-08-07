defmodule Hologram.ClientMFATest do
  use Hologram.Test.BasicCase, async: true

  alias Hologram.Test.Fixtures.ClientMFA.Module1
  alias Hologram.Test.Fixtures.ClientMFA.Module2

  test "__hologram_client_mfas__/0 collects declarations across multiple @hologram_client_mfa attributes and keyword entries" do
    assert Enum.sort(Module1.__hologram_client_mfas__()) ==
             Enum.sort(bar: 2, baz: 0, foo: 1)
  end

  test "__hologram_client_mfas__/0 returns an empty list when no @hologram_client_mfa is declared" do
    assert Module2.__hologram_client_mfas__() == []
  end

  test "raises when the declared function doesn't exist on the module" do
    expected_error_msg =
      "@hologram_client_mfa :foo/2 requires a public foo/2 function in " <>
        "Hologram.Test.Fixtures.ClientMFA.MissingFunction"

    assert_error ArgumentError, expected_error_msg, fn ->
      Code.eval_string("""
      defmodule Hologram.Test.Fixtures.ClientMFA.MissingFunction do
        use Hologram.ClientMFA

        @hologram_client_mfa foo: 2

        def foo(x), do: x
      end
      """)
    end
  end

  test "raises when the declared function is private" do
    expected_error_msg =
      "@hologram_client_mfa :foo/1 requires a public foo/1 function in " <>
        "Hologram.Test.Fixtures.ClientMFA.PrivateFunction"

    assert_error ArgumentError, expected_error_msg, fn ->
      Code.eval_string("""
      defmodule Hologram.Test.Fixtures.ClientMFA.PrivateFunction do
        use Hologram.ClientMFA

        @hologram_client_mfa foo: 1

        defp foo(x), do: x
      end
      """)
    end
  end
end
