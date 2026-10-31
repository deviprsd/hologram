defmodule Hologram.Assets.PathRegistry do
  @moduledoc false

  use GenServer

  alias Hologram.Commons.ETS
  alias Hologram.Commons.FileUtils
  alias Hologram.Commons.SerializationUtils
  alias Hologram.Reflection

  @doc """
  Returns the name of the ETS table used by the asset path registry registered process.
  """
  @callback ets_table_name() :: atom

  @doc """
  Returns the process name registered for the the asset path registry.
  """
  @callback process_name() :: atom

  @doc """
  Returns the paths of the compiler bundles this build environment wrote to the static dir,
  or nil when it recorded none.
  """
  @callback static_artifacts() :: [String.t()] | nil

  @doc """
  Returns the path of the static dir used by the asset path registry registered process.
  """
  @callback static_dir() :: String.t()

  @doc """
  Starts asset path registry process.
  """
  @spec start_link([]) :: GenServer.on_start()
  def start_link([]) do
    GenServer.start_link(__MODULE__, nil, name: impl().process_name())
  end

  @impl GenServer
  def init(nil) do
    ets_table_name = impl().ets_table_name()
    ETS.create_named_table(ets_table_name)
    ETS.put(ets_table_name, find_assets(impl().static_dir()))

    {:ok, nil}
  end

  @doc """
  Returns the asset path mapping.
  """
  @impl GenServer
  @spec handle_call(:get_mapping, GenServer.from(), nil) ::
          {:reply, %{String.t() => String.t()}, nil}
  def handle_call(:get_mapping, _from, nil) do
    {:reply, ETS.get_all(impl().ets_table_name()), nil}
  end

  @doc """
  Returns the implementation of the asset path registry's ETS table name.
  """
  @spec ets_table_name() :: atom
  def ets_table_name do
    __MODULE__
  end

  @doc """
  Returns the asset path mapping.
  """
  @spec get_mapping() :: %{String.t() => String.t()}
  def get_mapping do
    GenServer.call(impl().process_name(), :get_mapping)
  end

  @doc """
  Looks up the asset path (that includes the digest) of the given static file located in static dir.
  If there is no matching entry for the given static file then :error atom is returned.
  """
  @spec lookup(String.t()) :: {:ok, String.t()} | :error
  def lookup(static_path) do
    ETS.get(impl().ets_table_name(), static_path)
  end

  @doc """
  Returns the implementation of the asset path registry's process name.
  """
  @spec process_name() :: atom
  def process_name do
    __MODULE__
  end

  @doc """
  Registers the given asset path under the given static path key in the registry.
  """
  @spec register(String.t(), String.t()) :: true
  def register(static_path, asset_path) do
    ETS.put(impl().ets_table_name(), static_path, asset_path)
  end

  @doc """
  Reloads the path registry data.
  """
  @spec reload :: :ok
  def reload do
    ETS.replace_all(impl().ets_table_name(), find_assets(impl().static_dir()))
    :ok
  end

  @doc """
  Returns the paths of the compiler bundles that this build environment's last compile wrote, as
  its static artifacts manifest records them (see `Hologram.Reflection.static_artifacts_manifest_file_name/0`),
  or nil when there is no manifest or it is empty, e.g. in a build that never wrote one.
  """
  @spec static_artifacts() :: [String.t()] | nil
  def static_artifacts do
    manifest_path =
      Path.join(Reflection.build_dir(), Reflection.static_artifacts_manifest_file_name())

    with {:ok, data} <- File.read(manifest_path),
         [_first | _rest] = artifacts <- SerializationUtils.deserialize(data) do
      artifacts
    else
      _fallback -> nil
    end
  end

  @doc """
  Returns the implementation of the asset path registry's static dir path.
  """
  @spec static_dir() :: String.t()
  def static_dir do
    Reflection.otp_app_static_dir()
  end

  # A digest suffix is the 32 hex chars of an MD5, as `mix phx.digest` writes it, anywhere in the
  # static dir, or the 8 chars of esbuild's content hash, which the Hologram compiler names its
  # bundles with, only in the hologram dir. Anywhere else a name such as `arrow-DOWNLOAD.svg` would
  # be taken for a digested `arrow.svg`. The MD5 form is tried first, so a compiler bundle that
  # `mix phx.digest` digested again is read as it was before.
  defp digest_suffix_regexes(static_dir) do
    escaped_static_dir = Regex.escape(static_dir)

    [
      ~r"#{escaped_static_dir}/(.+)\-([0-9a-f]{32})(.+)$",
      ~r"#{escaped_static_dir}/(hologram/[^/]+)\-([A-Z2-7]{8})(\.[^/]+)$"
    ]
  end

  defp find_assets(static_dir) do
    static_files =
      static_dir
      |> FileUtils.list_files_recursively()
      |> reject_other_envs_bundles(static_dir, impl().static_artifacts())

    assets_with_digest_suffix = find_assets_with_digest_suffix(static_dir, static_files)

    already_used_registry_keys = Enum.map(assets_with_digest_suffix, &elem(&1, 0))

    assets_without_digest_suffix =
      static_dir
      |> find_assets_without_digest_suffix(static_files)
      |> Enum.reject(fn {key, _path} -> key in already_used_registry_keys end)

    # Two digested copies of one asset share a key. A single insert of a list leaves undefined which
    # duplicate the table keeps, so the copy that sorts last is picked here, to keep the choice
    # deterministic.
    (assets_with_digest_suffix ++ assets_without_digest_suffix)
    |> Map.new()
    |> Map.to_list()
  end

  defp find_assets_with_digest_suffix(static_dir, static_files) do
    regexes = digest_suffix_regexes(static_dir)

    static_files
    |> Stream.map(&match_digest_suffix(regexes, &1))
    |> Stream.filter(& &1)
    |> Stream.map(&List.to_tuple/1)
    |> stream_reject_compiler_bundles()
    |> stream_reject_source_maps()
    |> stream_build_asset_entries()
    |> Enum.to_list()
  end

  defp find_assets_without_digest_suffix(static_dir, static_files) do
    regexes = digest_suffix_regexes(static_dir)

    static_files
    |> Enum.reject(&match_digest_suffix(regexes, &1))
    |> Enum.map(fn absolute_file_path ->
      relative_file_path = String.replace_prefix(absolute_file_path, "#{static_dir}/", "")
      {relative_file_path, "/#{relative_file_path}"}
    end)
  end

  defp impl do
    Application.get_env(:hologram, :asset_path_registry_impl, __MODULE__)
  end

  defp match_digest_suffix(regexes, file_path) do
    Enum.find_value(regexes, &Regex.run(&1, file_path))
  end

  # The static dir is shared by every build environment of the project (see the note in
  # `Mix.Tasks.Compile.Hologram` on `:code.priv_dir/1`), so beside this environment's bundles it can
  # hold the ones another environment built, e.g. a dev runtime beside the test runtime. Those carry
  # the same names but for the content hash, and with the files sorted the last one would win the
  # registry key, whichever environment built it. A bundle this environment's manifest doesn't
  # name is another's, and is left out. Without a manifest every file is taken.
  defp reject_other_envs_bundles(static_files, _static_dir, nil), do: static_files

  defp reject_other_envs_bundles(static_files, static_dir, static_artifacts) do
    hologram_dir = Path.join(static_dir, "hologram")
    own_bundle_names = MapSet.new(static_artifacts, &Path.basename/1)

    Enum.reject(static_files, fn file_path ->
      Path.dirname(file_path) == hologram_dir and
        Regex.match?(~r/-[A-Z2-7]{8}\.[^\/]+$/, file_path) and
        Path.basename(file_path) not in own_bundle_names
    end)
  end

  defp stream_build_asset_entries(file_infos) do
    Stream.map(file_infos, fn {_file_path, prefix, digest, suffix} ->
      {prefix <> suffix, "/#{prefix}-#{digest}#{suffix}"}
    end)
  end

  # The bundles no static path looks up, since the page digest and chunk registries say which to
  # load: a page bundle, whose name carries its page module (hologram/page-<module>-<hash>.js),
  # and a chunk (hologram/chunk-<hash>.js), which all share the name left once the hash is taken
  # off.
  defp stream_reject_compiler_bundles(file_infos) do
    Stream.reject(file_infos, fn {_file_path, prefix, _digest, _suffix} ->
      prefix == "hologram/chunk" or String.starts_with?(prefix, "hologram/page-")
    end)
  end

  defp stream_reject_source_maps(file_infos) do
    Stream.reject(file_infos, fn {_file_path, _prefix, _digest, suffix} ->
      suffix == ".js.map"
    end)
  end
end
