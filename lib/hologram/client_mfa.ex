defmodule Hologram.ClientMFA do
  @moduledoc """
  Declares functions that must be compiled into the client bundle whenever their
  module is reachable, even though no client-reachable code contains a literal
  call to them.

  The compiler's call graph is built from static IR analysis, so it can only see
  literal remote calls (`Mod.fun(args)`, `apply(Mod, :fun, args)` with a literal
  module). A function reached only through a dynamic dispatch (e.g. a module atom
  read from state, as `function_exported?(source, :validate, 2)` and `source.validate(...)`
  in a plug-in/behaviour pattern) is invisible to that analysis and gets pruned from
  the bundle, even when its module is otherwise reachable.

  ## Example

      defmodule MyApp.WorkspaceSource do
        use Hologram.ClientMFA

        @hologram_client_mfa validate: 2

        @behaviour MyApp.DataGrid.Source

        @impl true
        def validate(change, row), do: :ok
      end

  Declaring `@hologram_client_mfa validate: 2` keeps `validate/2` in the client
  bundle whenever `MyApp.WorkspaceSource` itself is reachable (e.g. because its
  module atom is passed as a literal prop), regardless of whether any
  client-reachable code contains a literal call to it.
  """

  defmacro __using__(_opts) do
    quote do
      Module.register_attribute(__MODULE__, :hologram_client_mfa, accumulate: true)

      @before_compile Hologram.ClientMFA
    end
  end

  defmacro __before_compile__(env) do
    mfas =
      env.module
      |> Module.get_attribute(:hologram_client_mfa)
      |> Enum.flat_map(& &1)

    Enum.each(mfas, &ensure_public_function!(env, &1))

    quote do
      @doc false
      @spec __hologram_client_mfas__() :: list({atom, arity})
      def __hologram_client_mfas__, do: unquote(Macro.escape(mfas))
    end
  end

  defp ensure_public_function!(env, {function, arity}) do
    unless Module.defines?(env.module, {function, arity}, :def) do
      raise ArgumentError,
            "@hologram_client_mfa #{inspect(function)}/#{arity} requires a public " <>
              "#{function}/#{arity} function in #{inspect(env.module)}"
    end
  end
end
