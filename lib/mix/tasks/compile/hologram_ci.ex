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
  """

  use Mix.Task.Compiler

  require Logger

  alias Hologram.Commons.PLT
  alias Hologram.Compiler
  alias Hologram.Compiler.CallGraph
  alias Hologram.Compiler.Digraph
  alias Hologram.Compiler.IR
  alias Hologram.Reflection

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

      ir_plt = PLT.start(supervisor: sup)
      call_graph = CallGraph.start(supervisor: sup)
      CallGraph.add_non_discoverable_edges(call_graph)
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

      build_modules!(
        Enum.uniq(runtime_entry_modules ++ templatables),
        ir_plt,
        call_graph,
        umbrella?
      )

      # Must be computed before remove_manually_ported_mfas/1 strips the Task.await/1
      # vertex - matches Mix.Tasks.Compile.Hologram.compile/1's own ordering.
      async_mfas = CallGraph.list_async_mfas(call_graph)

      # expand_until_stable!/6 only converges IR onto the master call_graph - it does not
      # produce the runtime/page split or runtime_mfas used below. Those are derived once,
      # after convergence, in exactly Mix.Tasks.Compile.Hologram.compile/1's own order
      # (clone+strip -> list_runtime_mfas -> build_app_versions -> create_runtime_entry_file
      # -> remove_runtime_mfas! -> create_page_entry_files). An earlier version of this task
      # produced that split *inside* the convergence loop and returned it directly, which
      # ran app_versions/build_app_versions against a graph remove_runtime_mfas!/2 had
      # already stripped in place (it mutates and returns the same pid) - the wrong graph
      # for a call whose own docs say it must run before the split. Deriving it fresh, once,
      # in eager's literal order avoids that whole class of ordering bug by construial.
      call_graph =
        expand_until_stable!(ir_plt, call_graph, page_modules, templatables, umbrella?, sup)

      call_graph_for_runtime =
        call_graph
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

    page_mfas =
      Enum.flat_map(page_modules, fn page_module ->
        CallGraph.list_page_mfas(
          call_graph_for_pages,
          page_module,
          server_callback_analysis_by_templatable
        )
      end)

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
    server_reachable_vertices =
      Enum.flat_map(templatables, fn templatable ->
        Digraph.reachable(page_graph, [{templatable, :init, 3}, {templatable, :command, 3}])
      end)

    reachable_vertices =
      runtime_mfas ++
        page_mfas ++
        Digraph.reachable(runtime_graph, runtime_mfas) ++
        Digraph.reachable(page_graph, page_mfas) ++ server_reachable_vertices

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
      call_graph
    else
      build_modules!(missing_modules, ir_plt, call_graph, umbrella?)

      # remove_runtime_mfas!/2 mutates call_graph_for_runtime's own Agent in place
      # (Agent.cast) and returns the same pid, rather than a distinct process - only
      # one process to stop here, not two.
      CallGraph.stop(call_graph_for_pages)

      expand_until_stable!(ir_plt, call_graph, page_modules, templatables, umbrella?, sup)
    end
  end

  defp module_ir_built?(ir_plt, module) do
    match?({:ok, _ir}, PLT.get(ir_plt, module))
  end

  defp vertex_module({module, _function, _arity}), do: module
  defp vertex_module(module) when is_atom(module), do: module
end
