defmodule Hologram.Assets.PathRegistryTest do
  use Hologram.Test.BasicCase, async: false

  import Hologram.Assets.PathRegistry
  import Hologram.Test.Stubs
  import Mox

  alias Hologram.Assets.PathRegistry, as: AssetPathRegistry
  alias Hologram.Commons.ETS
  alias Hologram.Commons.SerializationUtils
  alias Hologram.Reflection

  use_module_stub :asset_path_registry

  setup :set_mox_global

  setup do
    setup_asset_path_registry(AssetPathRegistryStub, false)
  end

  test "get_mapping/0", %{mapping: mapping} do
    AssetPathRegistry.start_link([])
    assert get_mapping() == mapping
  end

  describe "handle_call/3" do
    test "get_mapping", %{mapping: mapping} do
      AssetPathRegistry.start_link([])
      process_name = AssetPathRegistryStub.process_name()

      assert GenServer.call(process_name, :get_mapping) == mapping
    end
  end

  test "init/1", %{mapping: mapping} do
    ets_table_name = AssetPathRegistryStub.ets_table_name()

    assert init(nil) == {:ok, nil}
    assert ets_table_exists?(ets_table_name)
    assert ETS.get_all(ets_table_name) == mapping
  end

  describe "lookup/2" do
    setup do
      AssetPathRegistry.start_link([])
      :ok
    end

    test "asset exists, has digest suffix" do
      assert lookup("test_dir_1/test_dir_2/test_file_1.css") ==
               {:ok, "/test_dir_1/test_dir_2/test_file_1-11111111111111111111111111111111.css"}
    end

    test "asset exists, has esbuild content hash suffix, in hologram dir" do
      assert lookup("hologram/runtime.js") == {:ok, "/hologram/runtime-AAAAAAAA.js"}
    end

    test "asset exists, has esbuild content hash-like suffix, outside hologram dir" do
      assert lookup("test_dir_3/test_file_11-DOWNLOAD.css") ==
               {:ok, "/test_dir_3/test_file_11-DOWNLOAD.css"}

      assert lookup("test_dir_3/test_file_11.css") == :error
    end

    test "asset exists, doesn't have digest suffix" do
      assert lookup("test_dir_3/test_file_10.css") ==
               {:ok, "/test_dir_3/test_file_10.css"}
    end

    test "asset doesn't exist" do
      assert lookup("invalid_file.css") == :error
    end

    test "chunk bundle named by esbuild" do
      assert lookup("hologram/chunk.js") == :error
      assert lookup("hologram/chunk-DDDDDDDD.js") == :error
    end

    test "page bundle named by esbuild" do
      assert lookup("hologram/page-Elixir.MyPage1.js") == :error
      assert lookup("hologram/page-Elixir.MyPage1-BBBBBBBB.js") == :error
    end
  end

  describe "bundles of another build environment in the shared static dir" do
    setup do
      hologram_dir = Path.join(AssetPathRegistryStub.static_dir(), "hologram")
      runtime_path = Path.join(hologram_dir, "runtime-ZZZZZZZZ.js")
      source_map_path = Path.join(hologram_dir, "runtime-ZZZZZZZZ.js.map")

      # Sorts after the stub's runtime-AAAAAAAA.js, as a digest of another env's runtime may
      File.write!(runtime_path, "// another env's runtime")
      File.write!(source_map_path, "{}")

      :ok
    end

    test "without a manifest, the last runtime in name order wins" do
      AssetPathRegistry.start_link([])

      assert lookup("hologram/runtime.js") == {:ok, "/hologram/runtime-ZZZZZZZZ.js"}
    end

    test "the runtime the manifest names wins, whatever it sorts as" do
      stub(AssetPathRegistryMock, :static_artifacts, fn ->
        ["/some/dir/hologram/runtime-AAAAAAAA.js", "/some/dir/hologram/runtime-AAAAAAAA.js.map"]
      end)

      AssetPathRegistry.start_link([])

      assert lookup("hologram/runtime.js") == {:ok, "/hologram/runtime-AAAAAAAA.js"}
    end

    test "files that are not compiler bundles are taken whether the manifest names them or not" do
      stub(AssetPathRegistryMock, :static_artifacts, fn ->
        ["/some/dir/hologram/runtime-AAAAAAAA.js"]
      end)

      AssetPathRegistry.start_link([])

      assert lookup("test_dir_3/test_file_10.css") == {:ok, "/test_dir_3/test_file_10.css"}

      assert lookup("test_dir_1/test_dir_2/test_file_1.css") ==
               {:ok, "/test_dir_1/test_dir_2/test_file_1-11111111111111111111111111111111.css"}
    end
  end

  describe "static_artifacts/0" do
    setup do
      manifest_path =
        Path.join(Reflection.build_dir(), Reflection.static_artifacts_manifest_file_name())

      original = File.read(manifest_path)

      on_exit(fn ->
        case original do
          {:ok, data} -> File.write!(manifest_path, data)
          {:error, _reason} -> File.rm(manifest_path)
        end
      end)

      [manifest_path: manifest_path]
    end

    test "reads the paths the manifest records", %{manifest_path: manifest_path} do
      File.write!(manifest_path, SerializationUtils.serialize(["/a/runtime-AAAAAAAA.js"]))

      assert AssetPathRegistry.static_artifacts() == ["/a/runtime-AAAAAAAA.js"]
    end

    test "no manifest", %{manifest_path: manifest_path} do
      File.rm(manifest_path)

      assert AssetPathRegistry.static_artifacts() == nil
    end

    test "empty manifest", %{manifest_path: manifest_path} do
      File.write!(manifest_path, SerializationUtils.serialize([]))

      assert AssetPathRegistry.static_artifacts() == nil
    end
  end

  test "register/2" do
    AssetPathRegistry.start_link([])
    AssetPathRegistry.register("my_static_path", "/my_asset_path")

    assert lookup("my_static_path") == {:ok, "/my_asset_path"}
  end

  describe "reload/0" do
    setup do
      AssetPathRegistry.start_link([])
      :ok
    end

    test "picks the digested copy that sorts last when an asset has two" do
      dir = AssetPathRegistryStub.static_dir() <> "/test_dir_3"
      File.write!(dir <> "/test_file_12-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.css", "")
      File.write!(dir <> "/test_file_12-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.css", "")

      reload()

      assert lookup("test_dir_3/test_file_12.css") ==
               {:ok, "/test_dir_3/test_file_12-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.css"}
    end

    test "replaces a stale value", %{mapping: mapping} do
      ets_table_name = AssetPathRegistryStub.ets_table_name()
      ETS.put(ets_table_name, "test_dir_3/test_file_10.css", "/stale")

      reload()

      assert ETS.get_all(ets_table_name) == mapping
    end

    test "removes a key the data no longer holds", %{mapping: mapping} do
      ets_table_name = AssetPathRegistryStub.ets_table_name()
      ETS.put(ets_table_name, :dummy_key, :dummy_value)

      reload()

      assert ETS.get_all(ets_table_name) == mapping
    end
  end

  test "start_link/1" do
    assert {:ok, pid} = AssetPathRegistry.start_link([])
    assert is_pid(pid)
    assert process_name_registered?(AssetPathRegistryStub.process_name())
    assert ets_table_exists?(AssetPathRegistryStub.ets_table_name())
  end
end
