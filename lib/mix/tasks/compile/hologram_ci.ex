defmodule Mix.Tasks.Compile.HologramCi do
  @moduledoc """
  Reachability-driven alternative to `Mix.Tasks.Compile.Hologram`, for memory-constrained
  cold CI/CD builds.

  `Mix.Tasks.Compile.Hologram` builds full IR for every module `Reflection.list_elixir_modules/0`
  returns - every loaded OTP application, not just what a page or the runtime actually
  needs - then materializes the whole call graph before determining what's reachable.
  On a real host app this can retain gigabytes of IR for modules (e.g. Ash Resources
  reached only through a generic Actions API, never referenced by name from any
  Hologram page or component) that are never part of any bundle. See
  github.com/deviprsd/hologram/issues/43 and /issues/50.

  This task builds IR only for modules actually reachable from pages and the runtime,
  discovered via the same reachability logic `Mix.Tasks.Compile.Hologram` already uses
  to decide what goes into a bundle (`CallGraph.list_runtime_mfas/2`,
  `CallGraph.list_page_mfas/3`) - just run repeatedly against a graph that starts small
  and grows only as far as those functions say is needed, instead of once against a
  graph that already contains everything.

  By default this still builds IR for *every* reachable module before rendering *any*
  page, same as the single-pass shape below. Setting `config :hologram, :page_batch_size`
  to a positive integer switches to a batched build (see "Batched page rendering"): pages
  are grouped by how much of their reachable module set they share with each other, and
  only one batch's page-specific IR is resident at a time, evicted before the next batch
  starts. See github.com/deviprsd/hologram/issues/52.

  Deliberately not a drop-in replacement for `Mix.Tasks.Compile.Hologram`:

    * No incremental/warm-build support - always does a full cold build. Correct for a
      one-shot CI/CD build stage; wrong for a long-running dev server's live reload.
    * No compiler lock - intended to run as a single one-shot process
      (`mix do loadpaths + compile.hologram_ci`) in a build pipeline, not concurrently
      with other compiler invocations.
    * Doesn't dump the module-digest PLT or call graph to disk - both exist solely to
      speed up a *later incremental* compile, which this task doesn't support. The page
      digest PLT, which the runtime does read (page/asset version lookups), is still
      built and dumped.

  `Mix.Tasks.Compile.Hologram` itself is completely unmodified by this task's
  existence - every app depends on it unchanged; this only runs where a build
  explicitly invokes `compile.hologram_ci` instead.

  ## Batched page rendering

  With `page_batch_size` unset, `run/1` builds IR for the full reachable set (runtime
  entry MFAs, every page, every component) into one `ir_plt`, then renders every page
  from it in one pass - the same "build everything reachable, then render everything"
  shape as the eager task, just with a smaller reachable set. Nothing is freed until
  the whole thing is done.

  With `page_batch_size` set, a discovery pass runs the same convergence loop once to
  learn (a) each page's own reachable module set - including, for every non-page
  component that page's template actually renders, that component's own init/3 and
  command/3 server-reachable set, attributed to just this page rather than kept
  globally resident - and (b) the runtime's reachable MFAs/app versions/async MFAs
  (computed from the fully-converged discovery graph - global properties, unaffected
  by batching), then discards that pass's IR entirely. Pages are then greedily
  clustered by Jaccard similarity of their module sets into batches of at most
  `page_batch_size` pages. Any module needed by more than one batch is promoted to a
  "core" set built once, up front, and kept resident for the whole run (along with the
  runtime's own reachable modules and any component reachable from no page's template
  at all, so runtime bundle content can never depend on batching); everything else is
  batch-specific, built just before its batch renders and deleted (`PLT.delete/2` +
  `CallGraph.remove_vertices/2`) right after. A page's full reachable set is always a
  subset of its own batch's core-plus-specific set by construction (batch module
  unions are built directly from the same per-page sets used to cluster), so this can
  only change *when* a module's IR is resident, never *what* ends up reachable -
  bundle content is unaffected by whether batching is on.
  """

  use Mix.Task.Compiler

  require Logger

  alias Hologram.Commons.PLT
  alias Hologram.Compiler
  alias Hologram.Compiler.CallGraph
  alias Hologram.Compiler.Digraph
  alias Hologram.Compiler.IR
  alias Hologram.Reflection

  # Below this, two pages sharing a handful of modules by coincidence would end up
  # sharing a batch for no real benefit; above it, batches would rarely merge at all
  # and page_batch_size would do all the work. Not load-bearing for correctness -
  # this only affects how much redundant per-batch rebuilding happens, never whether
  # a page ends up with the modules it needs.
  @similarity_threshold 0.3

  @impl Mix.Task.Compiler
  def run(_args) do
    opts = build_opts()
    {:ok, sup} = DynamicSupervisor.start_link(strategy: :one_for_one)

    try do
      Logger.info("Hologram CI: compiler started")

      File.mkdir_p!(opts[:build_dir])
      File.mkdir_p!(opts[:static_dir])
      File.mkdir_p!(opts[:tmp_dir])

      Compiler.maybe_install_js_deps(opts[:assets_dir], opts[:build_dir])

      umbrella? = Reflection.umbrella?()
      page_modules = Reflection.list_pages()
      Compiler.validate_page_modules(page_modules)
      templatables = page_modules ++ Reflection.list_components()

      # Seed with what CallGraph.list_runtime_mfas/2's and CallGraph.list_page_mfas/3's
      # own entry vertices need to already exist as graph vertices (they're roots, not
      # something reached *from* elsewhere, so nothing would ever discover them via
      # traversal): the runtime's fixed "always needed" MFAs, plus every page and
      # component - the same small, host-authored set
      # Mix.Tasks.Compile.Hologram.compile/1 already treats as unconditionally needed
      # (see its own server_callback_analysis_by_templatable/2 call), not
      # Reflection.list_elixir_modules/0's "every loaded OTP app" superset.
      runtime_entry_modules =
        CallGraph.list_runtime_entry_mfas()
        |> Enum.map(fn {module, _function, _arity} -> module end)
        |> Enum.uniq()

      {ir_plt, entry_files_info} =
        case Application.get_env(:hologram, :page_batch_size) do
          nil ->
            run_single_pass(
              page_modules,
              templatables,
              runtime_entry_modules,
              umbrella?,
              sup,
              opts
            )

          batch_size when is_integer(batch_size) and batch_size > 0 ->
            run_batched(
              page_modules,
              templatables,
              runtime_entry_modules,
              batch_size,
              umbrella?,
              sup,
              opts
            )
        end

      # ir_plt isn't read again after run_single_pass/6 or run_batched/7 above (not
      # dumped to disk, no other consumer downstream) - freeing it here means
      # Compiler.bundle/2's concurrent esbuild subprocesses, the phase with the highest
      # total memory pressure, don't have to compete with an ETS table that's already
      # dead weight. Matches Mix.Tasks.Compile.Hologram.compile/1's own ordering
      # (issue #44) - this task was simply missing the same fix.
      PLT.stop(ir_plt)

      # ir_plt isn't read again after this point (not dumped to disk, no other consumer
      # downstream) - freeing it here means Compiler.bundle/2's concurrent esbuild
      # subprocesses, the phase with the highest total memory pressure, don't have to
      # compete with an ETS table that's already dead weight. Matches
      # Mix.Tasks.Compile.Hologram.compile/1's own ordering (issue #44) - this task was
      # simply missing the same fix.
      PLT.stop(ir_plt)

      bundles_info = Compiler.bundle(entry_files_info, opts)

      {page_digest_plt, page_digest_plt_dump_path} =
        Compiler.build_page_digest_plt(bundles_info, Keyword.put(opts, :supervisor, sup))

      PLT.dump(page_digest_plt, page_digest_plt_dump_path)

      Logger.info("Hologram CI: compiler finished")

      :ok
    after
      DynamicSupervisor.stop(sup)
    end
  end

  defp build_opts do
    assets_dir = Path.join(Reflection.hologram_dep_dir(), "assets")
    build_dir = Reflection.build_dir()
    node_modules_path = Path.join(assets_dir, "node_modules")

    [
      assets_dir: assets_dir,
      build_dir: build_dir,
      esbuild_bin_path: Path.join([node_modules_path, ".bin", "esbuild"]),
      js_dir: Path.join(assets_dir, "js"),
      node_modules_path: node_modules_path,
      static_dir: Path.join(Reflection.otp_app_static_dir(), "hologram"),
      tmp_dir: Path.join(build_dir, "tmp")
    ]
  end

  # Unchanged from before page_batch_size existed: build the full reachable set into
  # one ir_plt, then render every page from it in one pass, in
  # Mix.Tasks.Compile.Hologram.compile/1's own order (clone+strip -> list_runtime_mfas
  # -> build_app_versions -> create_runtime_entry_file -> remove_runtime_mfas! ->
  # create_page_entry_files). This is what runs whenever page_batch_size is unset, so
  # its output must stay byte-for-byte identical to what shipped in #50.
  defp run_single_pass(page_modules, templatables, runtime_entry_modules, umbrella?, sup, opts) do
    ir_plt = PLT.start(supervisor: sup)
    call_graph = CallGraph.start(supervisor: sup)
    CallGraph.add_non_discoverable_edges(call_graph)

    build_modules!(
      Enum.uniq(runtime_entry_modules ++ templatables),
      ir_plt,
      call_graph,
      umbrella?
    )

    # Must be computed before remove_manually_ported_mfas/1 strips the Task.await/1
    # vertex - matches Mix.Tasks.Compile.Hologram.compile/1's own ordering.
    async_mfas = CallGraph.list_async_mfas(call_graph)

    {converged_call_graph, _page_module_sets, _always_core_modules} =
      expand_until_stable!(ir_plt, call_graph, page_modules, templatables, umbrella?, sup)

    call_graph_for_runtime =
      converged_call_graph
      |> CallGraph.clone(supervisor: sup)
      |> CallGraph.remove_manually_ported_mfas()

    runtime_mfas = CallGraph.list_runtime_mfas(call_graph_for_runtime, page_modules)
    app_versions = Compiler.build_app_versions(call_graph_for_runtime)

    runtime_entry_file_path =
      Compiler.create_runtime_entry_file(runtime_mfas, ir_plt, async_mfas, app_versions, opts)

    call_graph_for_pages = CallGraph.remove_runtime_mfas!(call_graph_for_runtime, runtime_mfas)

    page_entry_files_info =
      page_modules
      |> Compiler.create_page_entry_files(call_graph_for_pages, ir_plt, async_mfas, opts)
      |> Enum.map(fn {entry_name, entry_file_path} ->
        {entry_name, entry_file_path, "page"}
      end)

    entry_files_info = [{"runtime", runtime_entry_file_path, "runtime"} | page_entry_files_info]

    {ir_plt, entry_files_info}
  end

  # Discovery pass (run today's convergence loop once, extract per-page module sets and
  # the runtime's own global properties, then discard all its IR) -> cluster pages by
  # module-set similarity -> classify every module as core (needed by 2+ batches, or by
  # the runtime) or batch-specific -> pass 2 (persistent ir_plt/call_graph seeded with
  # core, batch loop building/rendering/evicting each batch's specific modules in turn).
  #
  # async_mfas, runtime_mfas and app_versions are all computed once here, from the fully
  # converged discovery graph, and reused as-is in pass 2 - they're global properties of
  # the whole reachable set (which modules the runtime needs, which MFAs are reachable
  # from Task.await/1), not something batching should be able to change. Computing
  # async_mfas from a batch's own graph instead would risk missing a Task.await/1 caller
  # that only exists in a *different* batch's modules, since list_async_mfas/1 walks
  # incoming edges within whatever graph it's given.
  defp run_batched(
         page_modules,
         templatables,
         runtime_entry_modules,
         batch_size,
         umbrella?,
         sup,
         opts
       ) do
    discovery_ir_plt = PLT.start(supervisor: sup)
    discovery_call_graph = CallGraph.start(supervisor: sup)
    CallGraph.add_non_discoverable_edges(discovery_call_graph)

    build_modules!(
      Enum.uniq(runtime_entry_modules ++ templatables),
      discovery_ir_plt,
      discovery_call_graph,
      umbrella?
    )

    {converged_discovery_graph, page_module_sets, always_core_modules} =
      expand_until_stable!(
        discovery_ir_plt,
        discovery_call_graph,
        page_modules,
        templatables,
        umbrella?,
        sup
      )

    async_mfas = CallGraph.list_async_mfas(converged_discovery_graph)

    discovery_call_graph_for_runtime =
      converged_discovery_graph
      |> CallGraph.clone(supervisor: sup)
      |> CallGraph.remove_manually_ported_mfas()

    runtime_mfas = CallGraph.list_runtime_mfas(discovery_call_graph_for_runtime, page_modules)
    app_versions = Compiler.build_app_versions(discovery_call_graph_for_runtime)

    # Unioned together: both are "can't attribute to one batch, so always keep
    # resident" sets - the runtime's own reachable modules, and modules only
    # discoverable via a component's (not a page's) own server-traversal supplement.
    unconditionally_core_modules =
      runtime_mfas
      |> Enum.map(&vertex_module/1)
      |> MapSet.new()
      |> MapSet.union(always_core_modules)

    CallGraph.stop(discovery_call_graph_for_runtime)
    PLT.stop(discovery_ir_plt)
    CallGraph.stop(converged_discovery_graph)

    batches = cluster_pages(page_module_sets, batch_size)

    {core_modules, batches_with_specific_modules} =
      classify_modules(batches, page_module_sets, MapSet.to_list(unconditionally_core_modules))

    ir_plt = PLT.start(supervisor: sup)
    call_graph = CallGraph.start(supervisor: sup)
    CallGraph.add_non_discoverable_edges(call_graph)

    build_modules!(
      Enum.uniq(runtime_entry_modules ++ templatables ++ MapSet.to_list(core_modules)),
      ir_plt,
      call_graph,
      umbrella?
    )

    runtime_entry_file_path =
      Compiler.create_runtime_entry_file(runtime_mfas, ir_plt, async_mfas, app_versions, opts)

    page_entry_files_info =
      Enum.flat_map(batches_with_specific_modules, fn {batch_pages, batch_modules} ->
        build_modules!(MapSet.to_list(batch_modules), ir_plt, call_graph, umbrella?)

        # Fresh per batch, from the master graph's current state (core + this batch's
        # now-built specific modules) - reusing one clone across batches would miss the
        # edges each batch's build_modules!/4 call just added.
        batch_call_graph_for_pages =
          call_graph
          |> CallGraph.clone(supervisor: sup)
          |> CallGraph.remove_manually_ported_mfas()
          |> CallGraph.remove_runtime_mfas!(runtime_mfas)

        result =
          batch_pages
          |> Compiler.create_page_entry_files(
            batch_call_graph_for_pages,
            ir_plt,
            async_mfas,
            opts
          )
          |> Enum.map(fn {entry_name, entry_file_path} ->
            {entry_name, entry_file_path, "page"}
          end)

        CallGraph.stop(batch_call_graph_for_pages)

        # Safe by construction: batch_modules only ever contains modules classify_modules/3
        # found needed by exactly this one batch, so no later batch can need what's
        # evicted here.
        evict_batch_modules!(ir_plt, call_graph, batch_modules)

        result
      end)

    entry_files_info = [{"runtime", runtime_entry_file_path, "runtime"} | page_entry_files_info]

    {ir_plt, entry_files_info}
  end

  # Public (not part of this task's actual interface - it's still only ever called
  # from run_batched/7) so it, classify_modules/3 and evict_batch_modules!/3 can be unit
  # tested directly against synthetic page/module data, the same reason
  # Hologram.Compiler.resolve_beam_source/2 was promoted from private to public.
  @doc false
  @spec cluster_pages(%{module => MapSet.t(module)}, pos_integer) :: [[module]]
  # Greedily groups pages by Jaccard similarity of their reachable module sets: sort
  # pages by descending set size, then for each page join whichever existing
  # under-capacity batch it's most similar to (above @similarity_threshold), or start a
  # new batch if none qualifies. A bin-packing heuristic only - batching worse than
  # optimal costs redundant rebuilding of modules across batches, never correctness,
  # since classify_modules/3 derives core/batch-specific status from whatever grouping
  # comes out of this, not the other way around.
  def cluster_pages(page_module_sets, batch_size) do
    page_module_sets
    |> Enum.sort_by(fn {_page, modules} -> -MapSet.size(modules) end)
    |> Enum.reduce([], fn {page, modules}, batches ->
      add_to_best_batch(batches, page, modules, batch_size)
    end)
    |> Enum.reverse()
    |> Enum.map(fn %{pages: pages} -> Enum.reverse(pages) end)
  end

  defp add_to_best_batch(batches, page, modules, batch_size) do
    best_match =
      batches
      |> Enum.with_index()
      |> Enum.filter(fn {%{pages: pages}, _index} -> length(pages) < batch_size end)
      |> Enum.map(fn {batch, index} -> {index, jaccard_similarity(batch.modules, modules)} end)
      |> Enum.filter(fn {_index, similarity} -> similarity >= @similarity_threshold end)
      |> Enum.max_by(fn {_index, similarity} -> similarity end, fn -> nil end)

    case best_match do
      nil ->
        [%{pages: [page], modules: modules} | batches]

      {index, _similarity} ->
        List.update_at(batches, index, fn batch ->
          %{pages: [page | batch.pages], modules: MapSet.union(batch.modules, modules)}
        end)
    end
  end

  defp jaccard_similarity(set_a, set_b) do
    union_size = MapSet.size(MapSet.union(set_a, set_b))

    if union_size == 0 do
      0.0
    else
      MapSet.size(MapSet.intersection(set_a, set_b)) / union_size
    end
  end

  @doc false
  @spec classify_modules([[module]], %{module => MapSet.t(module)}, [module]) ::
          {MapSet.t(module), [{[module], MapSet.t(module)}]}
  # A module needed by 2+ batches is "core": building it once and keeping it resident
  # for the whole run is cheaper than rebuilding (and re-evicting) it in every batch
  # that needs it. runtime_modules is unioned in unconditionally, regardless of how many
  # batches would otherwise classify it as core, so the runtime bundle's own reachable
  # set can never be affected by how pages happened to cluster.
  def classify_modules(batches, page_module_sets, runtime_modules) do
    batch_module_sets =
      Enum.map(batches, fn pages ->
        Enum.reduce(pages, MapSet.new(), fn page, acc ->
          MapSet.union(acc, page_module_sets[page])
        end)
      end)

    module_to_batch_indices =
      batch_module_sets
      |> Enum.with_index()
      |> Enum.reduce(%{}, fn {modules, index}, acc ->
        Enum.reduce(modules, acc, fn module, acc2 ->
          Map.update(acc2, module, MapSet.new([index]), &MapSet.put(&1, index))
        end)
      end)

    shared_modules =
      module_to_batch_indices
      |> Enum.filter(fn {_module, indices} -> MapSet.size(indices) > 1 end)
      |> Enum.map(&elem(&1, 0))
      |> MapSet.new()

    core_modules = MapSet.union(shared_modules, MapSet.new(runtime_modules))

    batches_with_specific_modules =
      Enum.map(Enum.zip(batches, batch_module_sets), fn {pages, modules} ->
        {pages, MapSet.difference(modules, core_modules)}
      end)

    {core_modules, batches_with_specific_modules}
  end

  @doc false
  @spec evict_batch_modules!(PLT.t(), CallGraph.t(), MapSet.t(module)) :: :ok
  # Frees a batch's specific modules' IR (the expensive part - full parsed ASTs) and
  # their graph vertices, before the next batch's build_modules!/4 call. Only ever
  # called with modules classify_modules/3 has already proven no other batch needs.
  def evict_batch_modules!(ir_plt, call_graph, batch_modules) do
    graph = CallGraph.get_graph(call_graph)

    vertices_to_remove =
      graph
      |> Digraph.vertices()
      |> Enum.filter(&MapSet.member?(batch_modules, vertex_module(&1)))

    CallGraph.remove_vertices(call_graph, vertices_to_remove)

    Enum.each(batch_modules, &PLT.delete(ir_plt, &1))
  end

  # Builds IR (and, for anything successfully built, graph edges + protocol dispatch
  # edges via CallGraph.patch/3, reused unchanged) for whichever of the given modules
  # don't already have IR in ir_plt. Erlang modules are skipped - MFAs from
  # CallGraph.list_runtime_mfas/2 and list_page_mfas/3 legitimately include calls into
  # the Erlang stdlib (:code, :lists, etc.), which have no Elixir AST for IR.for_module/2
  # to build and are handled by a separate hand-ported-JS mechanism entirely
  # (Compiler.get_erlang_function_js/4); Reflection.list_elixir_modules/0, which
  # Mix.Tasks.Compile.Hologram.build_ir_plt/1 enumerates from, never includes them in
  # the first place. A module Compiler.resolve_beam_source/2 can't resolve a path for
  # is also skipped, matching build_ir_plt/1's own behavior - and, unlike that task,
  # skipped modules are never passed to CallGraph.patch/3, since build_for_module/3's
  # PLT.get!/2 would raise for a module whose IR was never put.
  defp build_modules!(modules, ir_plt, call_graph, umbrella?) do
    built_modules =
      modules
      |> Enum.uniq()
      |> Enum.filter(&Reflection.elixir_module?/1)
      |> Enum.reject(&module_ir_built?(ir_plt, &1))
      |> Enum.filter(fn module ->
        case Compiler.resolve_beam_source(module, umbrella?) do
          nil ->
            false

          beam_source ->
            PLT.put(ir_plt, module, IR.for_module(module, beam_source))
            true
        end
      end)

    if built_modules != [] do
      diff = %{added_modules: built_modules, edited_modules: [], removed_modules: []}
      CallGraph.patch(call_graph, ir_plt, diff)
    end
  end

  # Repeatedly computes the *exact* call_graph_for_runtime/call_graph_for_pages/
  # runtime_mfas/page_mfas that Mix.Tasks.Compile.Hologram.compile/1's downstream half
  # would compute - not a check against the raw call_graph - because
  # CallGraph.remove_manually_ported_mfas/1 and remove_runtime_mfas!/2 (which rebuilds
  # rather than mutates) can change which paths a later BFS takes, so reachability on
  # the raw graph is not guaranteed to be a superset of reachability on the
  # clone-and-stripped graphs generation actually uses. Builds IR for whatever module a
  # round's clone-and-stripped computation points to that doesn't have it yet, then
  # redoes the whole computation - a module discovered this round can itself reference
  # further modules the previous round's graph didn't have edges for yet. Repeats until
  # a round builds nothing new, at which point redoing the computation again could not
  # find anything different, so this round's values are final and exactly what
  # Mix.Tasks.Compile.Hologram.compile/1 would have produced from a fully-eager graph.
  #
  # Returns {converged master call_graph, page_module_sets, always_core_modules}:
  #   * page_module_sets is %{page_module => MapSet.t(module)}, each page's own full
  #     reachable module set (list_page_mfas/3's own output plus this page's share of
  #     the two supplements above) - used by run_batched/7 to cluster and classify
  #     pages.
  #   * always_core_modules is every module only discoverable via a *component's* own
  #     init/3 or command/3 traversal - can't be attributed to one page, so run_batched/7
  #     keeps it resident unconditionally rather than guessing which batch(es) need it.
  # Callers that don't batch (run_single_pass/6) discard both.
  defp expand_until_stable!(ir_plt, call_graph, page_modules, templatables, umbrella?, sup) do
    call_graph_for_runtime =
      call_graph
      |> CallGraph.clone(supervisor: sup)
      |> CallGraph.remove_manually_ported_mfas()

    runtime_mfas = CallGraph.list_runtime_mfas(call_graph_for_runtime, page_modules)
    call_graph_for_pages = CallGraph.remove_runtime_mfas!(call_graph_for_runtime, runtime_mfas)

    page_graph = CallGraph.get_graph(call_graph_for_pages)

    server_callback_analysis_by_templatable =
      CallGraph.server_callback_analysis_by_templatable(page_graph, templatables)

    page_mfas_by_page =
      Map.new(page_modules, fn page_module ->
        {page_module,
         CallGraph.list_page_mfas(
           call_graph_for_pages,
           page_module,
           server_callback_analysis_by_templatable
         )}
      end)

    page_mfas =
      page_mfas_by_page
      |> Map.values()
      |> List.flatten()

    # list_runtime_mfas/2 and list_page_mfas/3 only return {module, function, arity}
    # vertices - CallGraph.finalize_reachable_mfas/2 (private) drops bare-module
    # vertices, which represent "this MFA's IR references this module as a struct/type
    # literal" (e.g. %SetuCommerce.Catalog.Product{}), not a function call. A bare-module
    # vertex's own outgoing edges (__struct__/0, __schema__/1, etc.) only exist once
    # *that* module's own IR has been built and patched - so if we only ever fed MFA
    # tuples back into needed_modules, a module reached only via a struct/type
    # reference would never get its IR built, and the fixpoint would stabilize having
    # missed it (and everything only reachable through it) entirely. Digraph.reachable/2
    # is public and safe to call directly here: seeding it with the already-known
    # reachable MFAs can only ever reveal a subset of what full traversal from the true
    # entry vertices would have reached, so this can't over-approximate the result.
    #
    # This supplements, rather than replaces, runtime_mfas/page_mfas themselves: those
    # also carry protocol-dispatch helper vertices computed by finalize_reachable_mfas/2
    # via a mechanism that isn't a normal graph edge walk (protocol_dispatch_dependency_vertices/2),
    # so Digraph.reachable/2 alone wouldn't discover them.
    runtime_graph = CallGraph.get_graph(call_graph_for_runtime)

    # CallGraph.server_callback_analysis_by_templatable/2 (called above) already walks
    # each templatable's server-executed code (from init/3 and command/3) to compute
    # protocol dispatch types and reflection MFAs - but list_reflection_mfas_reachable_from_server_init/2
    # filters that walk's result down to just __struct__/__schema__/__changeset__ vertices,
    # so an intermediate module on the path (e.g. an Ash domain module whose server-only
    # function calls into a resource) is traversed through but never returned by anything
    # this task calls, and so never enters needed_modules on its own. Redoing the same
    # walk here, keeping every vertex instead of the reflection-filtered slice, closes
    # that gap the same way the struct/type-reference fix above does.
    #
    # Deliberately not bounded by opaque_vertex?/protocol dispatch edges: doing so
    # (tried and reverted) traded a strict correctness regression - modules eager's own
    # type-tracking marks live (e.g. Date.Range, File.Stream) were missed - for a memory
    # reduction that a raw graph walk can't safely make anyway, since only the type-aware
    # fixpoint list_page_mfas/list_runtime_mfas already run above knows which protocol
    # implementations' types are actually live. Over-including here only costs IR that's
    # never rendered into a bundle (bundle content comes from create_runtime_entry_file/
    # create_page_entry_files re-deriving the same type-aware lists against the final
    # graph, not from this function's needed_modules).
    server_reachable_by_templatable =
      Map.new(templatables, fn templatable ->
        {templatable,
         Digraph.reachable(page_graph, [{templatable, :init, 3}, {templatable, :command, 3}])}
      end)

    # Computed per page rather than once against the combined page_mfas: needed_modules
    # below only cares about the union either way (BFS distributes over union of seeds),
    # but page_module_sets on convergence needs each page's own contribution kept apart
    # to cluster/classify correctly - see the comment there for why.
    bare_vertex_supplement_by_page =
      Map.new(page_mfas_by_page, fn {page_module, mfas} ->
        {page_module, Digraph.reachable(page_graph, mfas)}
      end)

    reachable_vertices =
      runtime_mfas ++
        page_mfas ++
        Digraph.reachable(runtime_graph, runtime_mfas) ++
        List.flatten(Map.values(bare_vertex_supplement_by_page)) ++
        List.flatten(Map.values(server_reachable_by_templatable))

    needed_modules =
      reachable_vertices
      |> Enum.map(&vertex_module/1)
      |> Enum.uniq()
      # Erlang modules never get IR (see build_modules!/4) so they'd otherwise look
      # perpetually "missing" here and this would never reach a fixpoint.
      |> Enum.filter(&Reflection.elixir_module?/1)

    missing_modules = Enum.reject(needed_modules, &module_ir_built?(ir_plt, &1))

    if missing_modules == [] do
      # call_graph_for_runtime/call_graph_for_pages (same pid - remove_runtime_mfas!/2
      # mutates in place) were only ever a convergence probe for this round's
      # needed_modules - the caller derives its own clone+split, in eager's exact order,
      # from the converged master call_graph this returns.
      CallGraph.stop(call_graph_for_pages)

      # A page's own reachable module set is more than list_page_mfas/3's output: that
      # function's entry points (list_page_entry_mfas/1) don't include init/3 at all, so
      # anything discovered only via the init/3 server-traversal supplement above (e.g.
      # an Ash domain module a page's init/3 calls into, which itself references a
      # resource - the SetuCommerce.Taxes.Invoice class of module from #50's own
      # investigation) is never part of list_page_mfas/3's result, no matter how
      # converged the graph is; it's a genuinely separate reachability channel, not
      # something list_page_mfas/3 would eventually subsume. Bare-vertex-supplement
      # content is unioned in for the same reason struct/type references needed it in
      # needed_modules above.
      # A page's own template reachability (page_mfas_by_page/bare_vertex_supplement_by_page)
      # already includes every component the page's template actually renders, as an
      # ordinary graph vertex - components aren't special-cased in that walk. So which
      # pages use a given component is derivable from this base set, before any
      # component's own init/3/command/3 server-reachable set is folded in below.
      base_page_module_sets =
        Map.new(page_modules, fn page_module ->
          modules =
            (page_mfas_by_page[page_module] ++ bare_vertex_supplement_by_page[page_module])
            |> Enum.map(&vertex_module/1)
            |> Enum.filter(&Reflection.elixir_module?/1)
            |> MapSet.new()

          {page_module, modules}
        end)

      components = Enum.reject(templatables, &(&1 in page_modules))

      # Each component's own init/3 and command/3 discoveries (e.g. an Ash domain module
      # a component's init/3 calls into) used to be attributed to no page at all and kept
      # globally resident unconditionally - correct, but far more conservative than
      # necessary: most components in a real app are rendered by only one or two pages,
      # not the whole app. Fold each component's server-reachable set into just the
      # pages whose *base* (component-attribution-independent) module set actually
      # contains that component, so a component's own dependencies only end up in
      # classify_modules/3's core set if 2+ *batches* genuinely share it - the same rule
      # every other module already goes through. A component reachable from no page's
      # base set at all (e.g. only ever dispatched to dynamically, never referenced by
      # name from a template) can't be attributed anywhere - keep that rare case in
      # always_core_modules, same conservative fallback as before.
      {page_module_sets, always_core_modules} =
        Enum.reduce(components, {base_page_module_sets, MapSet.new()}, fn component, acc ->
          attribute_component_dependencies(
            component,
            acc,
            page_modules,
            base_page_module_sets,
            server_reachable_by_templatable
          )
        end)

      # Pages are templatables too - fold each page's own init/3/command/3
      # server-reachable set into its own module set (unlike components, this never
      # needs attribution: a page's own server-traversal discoveries obviously belong
      # to that page).
      page_module_sets =
        Map.new(page_module_sets, fn {page_module, modules} ->
          own_server_modules =
            server_reachable_by_templatable[page_module]
            |> Enum.map(&vertex_module/1)
            |> Enum.filter(&Reflection.elixir_module?/1)
            |> MapSet.new()

          {page_module, MapSet.union(modules, own_server_modules)}
        end)

      {call_graph, page_module_sets, always_core_modules}
    else
      build_modules!(missing_modules, ir_plt, call_graph, umbrella?)

      # remove_runtime_mfas!/2 mutates call_graph_for_runtime's own Agent in place
      # (Agent.cast) and returns the same pid, rather than a distinct process - only
      # one process to stop here, not two.
      CallGraph.stop(call_graph_for_pages)

      expand_until_stable!(ir_plt, call_graph, page_modules, templatables, umbrella?, sup)
    end
  end

  @doc false
  @spec attribute_component_dependencies(
          module,
          {%{module => MapSet.t(module)}, MapSet.t(module)},
          [module],
          %{module => MapSet.t(module)},
          %{module => list}
        ) :: {%{module => MapSet.t(module)}, MapSet.t(module)}
  # Folds one component's own init/3 + command/3 server-reachable set into every page
  # whose *base* module set (ordinary template reachability, before any component's
  # server-reachable set is folded in) actually contains that component - or, if no
  # page's base set contains it, into always_acc as a conservative fallback (a
  # component only ever dispatched to dynamically, never referenced by name from any
  # template that reachability analysis walks).
  def attribute_component_dependencies(
        component,
        {pages_acc, always_acc},
        page_modules,
        base_page_module_sets,
        server_reachable_by_templatable
      ) do
    component_server_modules =
      server_reachable_by_templatable[component]
      |> Enum.map(&vertex_module/1)
      |> Enum.filter(&Reflection.elixir_module?/1)
      |> MapSet.new()

    using_pages = Enum.filter(page_modules, &MapSet.member?(base_page_module_sets[&1], component))

    pages_acc =
      Enum.reduce(using_pages, pages_acc, fn page, acc ->
        Map.update!(acc, page, &MapSet.union(&1, component_server_modules))
      end)

    always_acc =
      if using_pages == [],
        do: MapSet.union(always_acc, component_server_modules),
        else: always_acc

    {pages_acc, always_acc}
  end

  defp module_ir_built?(ir_plt, module) do
    match?({:ok, _ir}, PLT.get(ir_plt, module))
  end

  defp vertex_module({module, _function, _arity}), do: module
  defp vertex_module(module) when is_atom(module), do: module
end
