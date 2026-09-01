defmodule Mix.Tasks.Compile.HologramCiTest do
  use Hologram.Test.BasicCase, async: true
  import Mix.Tasks.Compile.HologramCi

  alias Hologram.Commons.PLT
  alias Hologram.Compiler.CallGraph
  alias Hologram.Compiler.Digraph
  alias Hologram.Compiler.IR

  # Real modules aren't needed here - cluster_pages/2, classify_modules/3 and
  # evict_batch_modules!/3 only ever deal in module atoms as opaque set members, never
  # inspecting or loading them.
  defp module_set(atoms), do: MapSet.new(atoms)

  describe "cluster_pages/2" do
    test "pages with fully disjoint module sets end up in separate batches" do
      page_module_sets = %{
        Page1 => module_set([A, B, C]),
        Page2 => module_set([X, Y, Z])
      }

      batches = cluster_pages(page_module_sets, _batch_size = 10)

      assert length(batches) == 2
      assert Enum.sort(List.flatten(batches)) == [Page1, Page2]
    end

    test "pages with heavily overlapping module sets join the same batch" do
      page_module_sets = %{
        Page1 => module_set([A, B, C, D]),
        Page2 => module_set([A, B, C, E])
      }

      batches = cluster_pages(page_module_sets, _batch_size = 10)

      assert [batch] = batches
      assert Enum.sort(batch) == [Page1, Page2]
    end

    test "never exceeds batch_size even when every page is identical" do
      page_module_sets = %{
        Page1 => module_set([A, B]),
        Page2 => module_set([A, B]),
        Page3 => module_set([A, B])
      }

      batches = cluster_pages(page_module_sets, _batch_size = 2)

      assert length(batches) == 2
      assert Enum.map(batches, &length/1) |> Enum.sort() == [1, 2]
      assert Enum.sort(List.flatten(batches)) == [Page1, Page2, Page3]
    end

    test "every page from the input appears in exactly one output batch" do
      page_module_sets = %{
        Page1 => module_set([A, B]),
        Page2 => module_set([A, C]),
        Page3 => module_set([X, Y]),
        Page4 => module_set([X, Z])
      }

      batches = cluster_pages(page_module_sets, _batch_size = 2)

      assert Enum.sort(List.flatten(batches)) == [Page1, Page2, Page3, Page4]
    end
  end

  describe "classify_modules/3" do
    test "a module needed by only one batch is batch-specific, not core" do
      batches = [[Page1], [Page2]]

      page_module_sets = %{
        Page1 => module_set([A, B]),
        Page2 => module_set([X, Y])
      }

      {core_modules, batches_with_specific_modules} =
        classify_modules(batches, page_module_sets, _runtime_modules = [])

      assert MapSet.size(core_modules) == 0

      assert [{[Page1], page1_specific}, {[Page2], page2_specific}] =
               batches_with_specific_modules

      assert page1_specific == module_set([A, B])
      assert page2_specific == module_set([X, Y])
    end

    test "a module needed by 2+ batches is promoted to core and excluded from both batches' specific sets" do
      batches = [[Page1], [Page2]]

      page_module_sets = %{
        Page1 => module_set([A, Shared]),
        Page2 => module_set([X, Shared])
      }

      {core_modules, batches_with_specific_modules} =
        classify_modules(batches, page_module_sets, _runtime_modules = [])

      assert core_modules == module_set([Shared])

      assert [{[Page1], page1_specific}, {[Page2], page2_specific}] =
               batches_with_specific_modules

      assert page1_specific == module_set([A])
      assert page2_specific == module_set([X])
    end

    test "runtime modules are always core, even if only one batch happens to need them" do
      batches = [[Page1]]
      page_module_sets = %{Page1 => module_set([A])}

      {core_modules, _batches_with_specific_modules} =
        classify_modules(batches, page_module_sets, _runtime_modules = [RuntimeOnly])

      assert MapSet.member?(core_modules, RuntimeOnly)
    end

    test "every page's full module set is a subset of its own batch's core-plus-specific set" do
      batches = [[Page1, Page2], [Page3]]

      page_module_sets = %{
        Page1 => module_set([A, Shared]),
        Page2 => module_set([B, Shared]),
        Page3 => module_set([Shared, C])
      }

      {core_modules, batches_with_specific_modules} =
        classify_modules(batches, page_module_sets, _runtime_modules = [])

      Enum.each(batches_with_specific_modules, fn {pages, batch_specific_modules} ->
        available = MapSet.union(core_modules, batch_specific_modules)

        Enum.each(pages, fn page ->
          assert MapSet.subset?(page_module_sets[page], available),
                 "#{inspect(page)}'s reachable set #{inspect(page_module_sets[page])} " <>
                   "isn't fully covered by its batch's core+specific set #{inspect(available)}"
        end)
      end)
    end
  end

  describe "attribute_component_dependencies/5" do
    test "a component used by exactly one page's base module set gets its server-reachable deps folded into just that page" do
      base_page_module_sets = %{
        Page1 => module_set([ComponentA]),
        Page2 => module_set([OtherComponent])
      }

      server_reachable_by_templatable = %{ComponentA => [Enum, String]}

      {page_module_sets, always_core_modules} =
        attribute_component_dependencies(
          ComponentA,
          {base_page_module_sets, MapSet.new()},
          [Page1, Page2],
          base_page_module_sets,
          server_reachable_by_templatable
        )

      assert MapSet.subset?(module_set([Enum, String]), page_module_sets[Page1])
      refute MapSet.member?(page_module_sets[Page2], Enum)
      assert MapSet.size(always_core_modules) == 0
    end

    test "a component used by no page's base module set falls back to always-core" do
      base_page_module_sets = %{Page1 => module_set([SomeOtherModule])}
      server_reachable_by_templatable = %{OrphanComponent => [Enum]}

      {page_module_sets, always_core_modules} =
        attribute_component_dependencies(
          OrphanComponent,
          {base_page_module_sets, MapSet.new()},
          [Page1],
          base_page_module_sets,
          server_reachable_by_templatable
        )

      assert page_module_sets == base_page_module_sets
      assert always_core_modules == module_set([Enum])
    end

    test "a component used by multiple pages' base module sets gets folded into all of them, not just one" do
      base_page_module_sets = %{
        Page1 => module_set([SharedComponent]),
        Page2 => module_set([SharedComponent]),
        Page3 => module_set([Unrelated])
      }

      server_reachable_by_templatable = %{SharedComponent => [String]}

      {page_module_sets, always_core_modules} =
        attribute_component_dependencies(
          SharedComponent,
          {base_page_module_sets, MapSet.new()},
          [Page1, Page2, Page3],
          base_page_module_sets,
          server_reachable_by_templatable
        )

      assert MapSet.member?(page_module_sets[Page1], String)
      assert MapSet.member?(page_module_sets[Page2], String)
      refute MapSet.member?(page_module_sets[Page3], String)
      assert MapSet.size(always_core_modules) == 0
    end
  end

  describe "evict_batch_modules!/3" do
    test "deletes a batch's specific modules' IR and vertices, leaving core modules untouched" do
      # DynamicSupervisor stopped inline at the end, rather than via on_exit/1 - PLT and
      # CallGraph's own :temporary child specs (see run/1's own supervisor: sup usage)
      # don't survive past this test process's own exit, and on_exit/1 callbacks run
      # afterwards, in a separate process.
      {:ok, sup} = DynamicSupervisor.start_link(strategy: :one_for_one)
      ir_plt = PLT.start(supervisor: sup)
      call_graph = CallGraph.start(supervisor: sup)

      # Fake IR is fine here - PLT.put/3 and Digraph.add_edge/3 don't inspect the value
      # or vertex shape, only evict_batch_modules!/3's own logic under test does.
      PLT.put(ir_plt, CoreModule, %IR.AtomType{value: :core})
      PLT.put(ir_plt, BatchModule, %IR.AtomType{value: :batch})

      CallGraph.add_edge(call_graph, {CoreModule, :fun, 1}, {BatchModule, :fun, 1})
      CallGraph.add_vertex(call_graph, CoreModule)
      CallGraph.add_vertex(call_graph, BatchModule)

      evict_batch_modules!(ir_plt, call_graph, MapSet.new([BatchModule]))

      assert PLT.get(ir_plt, CoreModule) == {:ok, %IR.AtomType{value: :core}}
      assert PLT.get(ir_plt, BatchModule) == :error

      graph = CallGraph.get_graph(call_graph)
      vertices = Digraph.vertices(graph)

      assert CoreModule in vertices
      refute BatchModule in vertices
      refute {BatchModule, :fun, 1} in vertices
      # The edge's source vertex (CoreModule's own MFA) survives - only vertices whose
      # *module* is BatchModule are removed.
      assert {CoreModule, :fun, 1} in vertices

      DynamicSupervisor.stop(sup)
    end
  end
end
