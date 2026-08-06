defmodule Hologram.Template.DOM do
  @moduledoc false

  alias Hologram.Commons.StringUtils
  alias Hologram.Compiler.AST
  alias Hologram.Template.EventModifiers
  alias Hologram.Template.Helpers
  alias Hologram.Template.Parser
  alias Hologram.TemplateSyntaxError

  # Blocks whose rendered node count can change between renders, shifting the position of every
  # sibling that follows them. "raw" and "else" are absent because neither delimits a region whose
  # size can vary: "raw" only marks source to reconstruct, and "else" is a branch within an "if".
  @marked_blocks ["for", "if"]

  @type attribute :: {String.t(), t} | {:spread, {any}}

  # 'dom_node' name used instead of 'node" because type node/0 is a built-in type and it cannot be redefined.
  @type dom_node ::
          {:component, module, list(attribute), t}
          | {:dynamic_tag, {any}, list(attribute), t}
          | {:element, String.t(), list(attribute), t}
          | {:expression, {any}}
          | {:page, module, list(attribute), []}
          | {:public_comment, t}
          | {:text, String.t()}

  @type t :: dom_node | list(dom_node())

  @doc """
  Builds DOM AST from the given parsed tags.

  ## Examples

      iex> tags = [{:start_tag, {"div, []}}, {:text, "abc"}, {:end_tag, "div"}]
      iex> build_ast(tags)
      [{:{}, [line: 1], [:element, "div", [], [{:text, "abc"}]]}]
  """
  @spec build_ast(list(Parser.parsed_tag())) :: AST.t()
  def build_ast(tags) do
    {code, _last_tag_type} =
      tags
      |> resolve_for_key_plans()
      |> add_block_markers()
      |> Enum.reduce({"", nil}, fn tag, {code_acc, last_tag_type} ->
        current_tag_type = if is_tuple(tag), do: elem(tag, 0), else: tag

        # :skip items are fully elided, as if they did not appear
        case render_code(tag) do
          :skip ->
            {code_acc, last_tag_type}

          current_tag_code ->
            {append_code(code_acc, current_tag_code, last_tag_type), current_tag_type}
        end
      end)

    "[#{code}]"
    |> AST.for_code()
    |> substitute_module_attributes()
  end

  # Decides, for every "for" block, how its items get keyed - and rewrites the tag stream to carry
  # that decision, since add_block_markers/1 (which runs next) is where the decision is finally
  # spliced into generated code but has no way to look ahead at a block's body to derive it.
  #
  # Runs as its own pass, before add_block_markers/1, because deriving the decision needs a
  # different kind of lookahead than marking does: marking only needs to find each block's matching
  # end tag, while this needs to inspect the block's *body* - its generator shape, and whether one
  # of its top-level tags carries an explicit $key - before the block's own opening tag can be
  # rewritten. A single forward pass can't rewrite a tag it already emitted, so this walks the tag
  # list twice: once to work out each "for" block's plan (keyed by that block's position in `tags`,
  # since positions are stable and unique), once to apply it.
  #
  # A "for" block's key plan is one of:
  #   :none                a multi-generator or destructuring-pattern loop with no $key - falls
  #                         back to positional diffing, unchanged from before this module existed
  #   {:auto, var_name}     a single plain-variable generator - keyed by the bound item's own :id
  #                         at runtime, chosen per iteration since only the runtime sees the item
  #   {:explicit, source}   a $key={...} attribute on a top-level tag of the block's body
  defp resolve_for_key_plans(tags) do
    indexed_tags = Enum.with_index(tags)

    initial_state = %{
      for_stack: [],
      element_depth: 0,
      raw_depth: 0,
      plans: %{},
      guards: %{},
      guard_refs: %{},
      strip: MapSet.new()
    }

    final_state = Enum.reduce(indexed_tags, initial_state, &scan_for_key_plan_tag/2)

    Enum.map(indexed_tags, fn {tag, index} ->
      apply_for_key_plan(tag, index, final_state)
    end)
  end

  # Rewrites a "for" block's own start tag to carry its resolved key plan and memoization guard
  # list, and strips the $key attribute (if any) from whichever tag carried it - the marker
  # machinery reads the key from the loop variable or the hoisted expression, not from an
  # attribute left on the rendered element, and an unstripped "$key" would otherwise reach
  # #buildEventBinding as a bogus "key" event.
  defp apply_for_key_plan({:block_start, {"for", expr_str}}, index, state) do
    {:block_start,
     {"for", expr_str, Map.fetch!(state.plans, index), Map.fetch!(state.guards, index)}}
  end

  defp apply_for_key_plan({:start_tag, {tag_name, attrs}}, index, state) do
    {:start_tag, {tag_name, strip_key_attr(attrs, index, state.strip)}}
  end

  defp apply_for_key_plan({:self_closing_tag, {tag_name, attrs}}, index, state) do
    {:self_closing_tag, {tag_name, strip_key_attr(attrs, index, state.strip)}}
  end

  defp apply_for_key_plan(tag, _index, _state), do: tag

  defp strip_key_attr(attrs, index, strip) do
    if MapSet.member?(strip, index) do
      Enum.reject(attrs, &match?({"$key", _value_parts}, &1))
    else
      attrs
    end
  end

  defp find_key_attr(attrs) do
    Enum.find(attrs, &match?({"$key", _value_parts}, &1))
  end

  # A for-frame's key_expr can only be set once a body tag is scanned, after the frame was already
  # pushed - so it's updated on the stack in place rather than threaded back through a return value
  # the way a stateless fold clause normally would.
  defp handle_key_attr(state, attrs, index) do
    case find_key_attr(attrs) do
      nil ->
        state

      {_name, value_parts} ->
        [frame | rest] = state.for_stack

        unless state.element_depth == frame.entry_depth do
          raise TemplateSyntaxError,
            message:
              ~s'the "$key" attribute must be set on a top-level element of the "for" block body, not a nested one'
        end

        if frame.key_expr do
          raise TemplateSyntaxError,
            message: ~s'the "for" block body has more than one "$key" attribute'
        end

        unless match?([{:expression, _expr}], value_parts) do
          raise TemplateSyntaxError,
            message: ~s'the "$key" attribute must be a single expression, e.g. $key={item.id}'
        end

        [{:expression, expr_str}] = value_parts
        key_expr = extract_expression_content(expr_str)

        %{
          state
          | for_stack: [%{frame | key_expr: key_expr} | rest],
            strip: MapSet.put(state.strip, index)
        }
    end
  end

  # Parses the "for" block's own generator clause (the same source render_code/1 later splices
  # into "(for <this> do [...] end)") to decide whether it is a single plain-variable generator -
  # the only shape whose bound item can be looked up by name inside the block's body, which is what
  # {:auto, var_name} does at render time. Anything else (a destructuring pattern, a bitstring
  # generator, more than one generator) can still be keyed explicitly with $key, just not derived
  # automatically. Falls back to no auto-key rather than raising: this only feeds a heuristic, not
  # something the template author wrote and might have gotten wrong.
  defp infer_auto_key_var(expr_str) do
    content = extract_expression_content(expr_str)

    case Code.string_to_quoted("for #{content}, do: nil") do
      {:ok, {:for, _for_meta, args}} ->
        {_do_block, qualifiers} = List.pop_at(args, -1)
        single_plain_var_generator(qualifiers)

      _error ->
        nil
    end
  end

  defp single_plain_var_generator(qualifiers) do
    generators = Enum.filter(qualifiers, &match?({:<-, _meta, [_pattern, _rhs]}, &1))

    case generators do
      [{:<-, _meta, [{var_name, _var_meta, ctx}, _rhs]}]
      when is_atom(var_name) and is_atom(ctx) ->
        auto_key_var_name(var_name)

      _other ->
        nil
    end
  end

  defp auto_key_var_name(var_name) do
    if underscored_var?(var_name), do: nil, else: var_name
  end

  defp underscored_var?(var_name) do
    var_name
    |> Atom.to_string()
    |> String.starts_with?("_")
  end

  # Collects every name a "for" block's own generator clause(s) bind - the pattern side of every
  # `<-` qualifier, list or bitstring. This is the whitelist a memoized keyed block's guard list
  # draws from: a name referenced in the body is only a safe, in-scope guard if it's bound here or
  # by an enclosing "for" (see collect_refs/1 and the block_end "for" clause below).
  defp collect_generator_bound_vars(expr_str) do
    content = extract_expression_content(expr_str)

    case Code.string_to_quoted("for #{content}, do: nil") do
      {:ok, {:for, _for_meta, args}} ->
        {_do_block, qualifiers} = List.pop_at(args, -1)

        qualifiers
        |> Enum.filter(&match?({:<-, _meta, [_pattern, _rhs]}, &1))
        |> Enum.reduce(MapSet.new(), fn {:<-, _meta, [pattern, _rhs]}, acc ->
          MapSet.union(acc, pattern_vars(pattern))
        end)

      _error ->
        MapSet.new()
    end
  end

  defp pattern_vars(ast) do
    {_ast, vars} =
      Macro.prewalk(ast, MapSet.new(), fn
        {name, _meta, ctx} = node, acc when is_atom(name) and is_atom(ctx) and name != :_ ->
          {node, MapSet.put(acc, name)}

        node, acc ->
          {node, acc}
      end)

    vars
  end

  # Collects the plain-variable and module-attribute names an expression fragment references, for
  # the same guard-list purpose as pattern_vars/1 above. Distinguishes a variable use from a
  # 0-arity local call the same way single_plain_var_generator/1 already does: a variable's third
  # AST element is a context atom, a call's is an (possibly empty) argument list.
  defp collect_refs(ast) do
    {_ast, {vars, attrs}} =
      Macro.prewalk(ast, {MapSet.new(), MapSet.new()}, fn
        {:@, _meta, [{name, _m2, ctx2}]} = node, {vars, attrs}
        when is_atom(name) and is_atom(ctx2) ->
          {node, {vars, MapSet.put(attrs, name)}}

        {name, _meta, ctx} = node, {vars, attrs} when is_atom(name) and is_atom(ctx) ->
          {node, {MapSet.put(vars, name), attrs}}

        node, acc ->
          {node, acc}
      end)

    {vars, attrs}
  end

  # Parses one brace-wrapped template expression fragment ("{item.name}", a $key value, a "for"
  # generator, an "if" condition) and returns its referenced names. Never raises: an expression
  # this pass can't parse (or that used the implicit-keyword-list shorthand differently than
  # expected) just contributes no refs, which only costs guard-list precision, not correctness -
  # the body still evaluates in full on every cache miss regardless of what the guard list omits.
  defp parse_and_collect_refs(expr_str) do
    content =
      expr_str
      |> normalize_implicit_keyword_list()
      |> extract_expression_content()

    case Code.string_to_quoted(content) do
      {:ok, ast} -> collect_refs(ast)
      _error -> {MapSet.new(), MapSet.new()}
    end
  end

  # Folds a batch of expression fragments' refs into every "for" frame currently open - a name
  # referenced anywhere inside a block's body (including a nested block's own body) is a
  # dependency of that block's own memoized output, since the nested block's rendering is part of
  # what the outer block caches.
  defp add_expr_refs(state, []), do: state
  defp add_expr_refs(%{for_stack: []} = state, _expr_strs), do: state

  defp add_expr_refs(state, expr_strs) do
    {vars, attrs} =
      Enum.reduce(expr_strs, {MapSet.new(), MapSet.new()}, fn expr_str, {vacc, aacc} ->
        {v, a} = parse_and_collect_refs(expr_str)
        {MapSet.union(vacc, v), MapSet.union(aacc, a)}
      end)

    guard_refs =
      Enum.reduce(state.for_stack, state.guard_refs, fn frame, acc ->
        Map.update!(acc, frame.start_index, fn %{vars: fv, attrs: fa} ->
          %{vars: MapSet.union(fv, vars), attrs: MapSet.union(fa, attrs)}
        end)
      end)

    %{state | guard_refs: guard_refs}
  end

  defp add_tag_name_refs(state, {:expression, dyn_expr_str}),
    do: add_expr_refs(state, [dyn_expr_str])

  defp add_tag_name_refs(state, _tag_name), do: state

  # "$key" itself is excluded: whatever it references already determines the item's cache key
  # (render_item_key_source/1), so a change there already lands on a different cache entry -
  # guarding on it too would only cost hit rate for no soundness gain.
  defp add_attrs_refs(state, attrs) do
    expr_strs =
      attrs
      |> Enum.reject(&match?({"$key", _value_parts}, &1))
      |> Enum.flat_map(fn
        {:spread, spread_expr} ->
          [spread_expr]

        {_name, value_parts} ->
          Enum.flat_map(value_parts, fn
            {:expression, expr_str} -> [expr_str]
            _other -> []
          end)
      end)

    add_expr_refs(state, expr_strs)
  end

  defp scan_for_key_plan_tag({{:start_tag, {tag_name, attrs}}, index}, state) do
    scanned_state =
      state
      |> scan_key_attr(attrs, index)
      |> add_tag_name_refs(tag_name)
      |> add_attrs_refs(attrs)

    raw_state =
      if tag_name in ["script", "style"],
        do: bump_raw_depth(scanned_state),
        else: scanned_state

    %{raw_state | element_depth: raw_state.element_depth + 1}
  end

  defp scan_for_key_plan_tag({{:end_tag, tag_name}, _index}, state) do
    state = %{state | element_depth: state.element_depth - 1}
    if tag_name in ["script", "style"], do: drop_raw_depth(state), else: state
  end

  # A self-closing tag opens and closes in the same tag, so it leaves element_depth (and
  # raw_depth - a self-closing <script/> or <style/> has no body, so there is no "inside" to be
  # raw) unchanged. It is still eligible to carry a top-level $key, so it gets the same $key scan
  # as a start tag, just without the depth bookkeeping.
  defp scan_for_key_plan_tag({{:self_closing_tag, {tag_name, attrs}}, index}, state) do
    state
    |> scan_key_attr(attrs, index)
    |> add_tag_name_refs(tag_name)
    |> add_attrs_refs(attrs)
  end

  defp scan_for_key_plan_tag({{:expression, expr_str}, _index}, state) do
    add_expr_refs(state, [expr_str])
  end

  defp scan_for_key_plan_tag({{:block_start, {"if", expr_str}}, _index}, state) do
    add_expr_refs(state, [expr_str])
  end

  defp scan_for_key_plan_tag({{:block_start, {"for", expr_str}}, index}, state) do
    # The generator clause itself is evaluated once per render (outside any per-item guard), so
    # its refs belong to the *enclosing* frames' guard lists, not this block's own - added before
    # this frame is pushed.
    state = add_expr_refs(state, [expr_str])

    auto_var = if state.raw_depth == 0, do: infer_auto_key_var(expr_str), else: nil

    bound_vars =
      if state.raw_depth == 0, do: collect_generator_bound_vars(expr_str), else: MapSet.new()

    frame = %{
      start_index: index,
      entry_depth: state.element_depth,
      key_expr: nil,
      auto_var: auto_var,
      bound_vars: bound_vars
    }

    guard_refs = Map.put(state.guard_refs, index, %{vars: MapSet.new(), attrs: MapSet.new()})

    %{state | for_stack: [frame | state.for_stack], guard_refs: guard_refs}
  end

  defp scan_for_key_plan_tag({{:block_end, "for"}, _index}, state) do
    [frame | rest] = state.for_stack

    key_plan =
      cond do
        frame.key_expr -> {:explicit, frame.key_expr}
        frame.auto_var -> {:auto, frame.auto_var}
        true -> :none
      end

    %{
      state
      | for_stack: rest,
        plans: Map.put(state.plans, frame.start_index, key_plan),
        guards: Map.put(state.guards, frame.start_index, resolve_guards(frame, rest, state))
    }
  end

  defp scan_for_key_plan_tag(_indexed_tag, state), do: state

  # A referenced name is a safe guard only if it's bound by this block's own generator or an
  # enclosing "for" block's generator - see collect_refs/1's moduledoc-adjacent comment. Over-
  # including a name that's out of scope at the memoized_item/5 call site would be a compile
  # error, so there's no "include everything referenced" fallback; under-including only costs hit
  # rate. Module attributes are always in scope (rewritten to `vars.foo` later by
  # substitute_module_attributes/1) and always included.
  defp resolve_guards(frame, enclosing_frames, state) do
    in_scope_vars =
      Enum.reduce(enclosing_frames, frame.bound_vars, fn ancestor, acc ->
        MapSet.union(acc, ancestor.bound_vars)
      end)

    %{vars: ref_vars, attrs: ref_attrs} = Map.fetch!(state.guard_refs, frame.start_index)

    guard_vars = MapSet.intersection(ref_vars, in_scope_vars)

    var_sources = Enum.map(guard_vars, &Atom.to_string/1)
    attr_sources = Enum.map(ref_attrs, &("@" <> Atom.to_string(&1)))

    Enum.sort(var_sources ++ attr_sources)
  end

  defp bump_raw_depth(state), do: %{state | raw_depth: state.raw_depth + 1}
  defp drop_raw_depth(state), do: %{state | raw_depth: max(state.raw_depth - 1, 0)}

  defp scan_key_attr(state, attrs, index) do
    case state.for_stack do
      [] ->
        if find_key_attr(attrs) do
          raise TemplateSyntaxError,
            message: ~s'the "$key" attribute is only allowed inside a "for" block'
        end

        state

      _frames ->
        handle_key_attr(state, attrs, index)
    end
  end

  # Brackets each block in a pair of marker comments, so that changing how many nodes the block
  # renders can't change the identity of the block's siblings. The client diffs children by tag and
  # position, so without the markers a block that starts rendering an extra node lets the following
  # sibling be paired with the block's content and rebuilt, destroying focus, scroll position and
  # media state.
  #
  # Blocks inside <script> and <style> are left alone: a comment there would be part of the script
  # or stylesheet source rather than markup, and their text-only children have no identity to
  # protect anyway.
  defp add_block_markers(tags) do
    hash = template_hash(tags)

    {marked_tags, _state} =
      Enum.flat_map_reduce(tags, {0, [], 0}, &inject_block_markers(&1, &2, hash))

    marked_tags
  end

  # Builds one marker comment, whose text is four bracketed segments, e.g. "[h:a3f2b1c4:0:o]":
  #
  #   h         namespace, distinguishing a marker from a comment written in the template
  #   a3f2b1c4  template hash, see template_hash/1
  #   0         index of the block within its template, counted in source order
  #   o         side of the pair, "o" opening or "c" closing
  #
  # The marker text doubles as the client-side vnode key, which is why it has to be part of the
  # markup: the client diffs against a virtual DOM derived from server-rendered HTML, and a
  # comment's own text is the only carrier that survives serialization. The client recognizes the
  # same format in Vdom.markerKey/1.
  #
  # Takes the tags that follow the marker, so an opening marker can be built in front of its block
  # without appending to the list it just built.
  defp marker_tags(hash, index, side, tail \\ []) do
    [
      :public_comment_start,
      {:text, "[h:#{hash}:#{index}:#{side}]"},
      :public_comment_end
      | tail
    ]
  end

  defp append_code(code_acc, code, last_tag_type)
       when last_tag_type in [
              :block_end,
              :doctype,
              :end_tag,
              :expression,
              :public_comment_end,
              :self_closing_tag,
              :text
            ] do
    code_acc <> ", " <> code
  end

  defp append_code(code_acc, code, _last_tag_type) do
    code_acc <> code
  end

  # Splits a "$"-prefixed event attribute name on "." into the bare name and its
  # raw modifier segments. Names without "$" (or without ".") carry no modifiers.
  defp decompose_event_attribute_name("$" <> _rest = name) do
    case String.split(name, ".") do
      [base_name] -> {base_name, []}
      [base_name | modifiers] -> {base_name, modifiers}
    end
  end

  defp decompose_event_attribute_name(name), do: {name, []}

  defp extract_expression_content(expr_str) do
    expr_str
    |> String.slice(1, String.length(expr_str) - 2)
    |> String.trim()
  end

  # State is {next block index, stack of open blocks, nesting depth inside <script>/<style>}. A
  # block opened inside raw text pushes :skipped so that its end tag pops the stack without
  # emitting a closing marker. Otherwise the stack holds {block_index, key_plan} - key_plan is
  # `nil` for "if" (there is no such thing as a keyed "if") and the resolve_for_key_plans/1 result
  # for "for", carried here only so block_end can find it again to stamp the closing tag the same
  # way; add_block_markers/1 doesn't otherwise care what a "for" block's key plan is.
  defp inject_block_markers({:start_tag, {tag_name, _attrs}} = tag, {index, open, depth}, _hash)
       when tag_name in ["script", "style"] do
    {[tag], {index, open, depth + 1}}
  end

  defp inject_block_markers({:end_tag, tag_name} = tag, {index, open, depth}, _hash)
       when tag_name in ["script", "style"] do
    {[tag], {index, open, max(depth - 1, 0)}}
  end

  # "for", not inside <script>/<style>: stamps this occurrence's hash and index onto the block's
  # own start tag, so render_code/1 can build the marker text for each item without needing the
  # fold state add_block_markers/1 carries but render_code/1 doesn't.
  defp inject_block_markers(
         {:block_start, {"for", expr_str, key_plan, guards}},
         {index, open, 0},
         hash
       ) do
    tag = {:block_start, {"for", expr_str, key_plan, guards, hash, index}}
    {marker_tags(hash, index, "o", [tag]), {index + 1, [{index, key_plan} | open], 0}}
  end

  # "if" is the only other member of @marked_blocks - "for" always arrives as the 3-tuple the
  # clause above matches, since resolve_for_key_plans/1 runs on every "for" block unconditionally.
  defp inject_block_markers({:block_start, {"if", _expr}} = tag, {index, open, 0}, hash) do
    {marker_tags(hash, index, "o", [tag]), {index + 1, [{index, nil} | open], 0}}
  end

  # Inside <script>/<style>: the block still has to compile (it may render into the raw text), but
  # gets no markers - resolve_for_key_plans/1 already forces key_plan to :none here, so the start
  # tag is left as the bare 4-tuple render_code/1's plain, unstamped "for" clause matches.
  defp inject_block_markers(
         {:block_start, {"for", _expr_str, _key_plan, _guards}} = tag,
         {index, open, depth},
         _hash
       ) do
    {[tag], {index, [:skipped | open], depth}}
  end

  defp inject_block_markers({:block_start, {"if", _expr}} = tag, {index, open, depth}, _hash) do
    {[tag], {index, [:skipped | open], depth}}
  end

  defp inject_block_markers(
         {:block_end, block_name} = tag,
         {index, [:skipped | open], depth},
         _hash
       )
       when block_name in @marked_blocks do
    {[tag], {index, open, depth}}
  end

  defp inject_block_markers(
         {:block_end, "for"},
         {index, [{block_index, key_plan} | open], depth},
         hash
       )
       when key_plan != nil do
    tag = {:block_end, {"for", key_plan, hash, block_index}}
    {[tag | marker_tags(hash, block_index, "c")], {index, open, depth}}
  end

  defp inject_block_markers(
         {:block_end, "if"} = tag,
         {index, [{block_index, nil} | open], depth},
         hash
       ) do
    {[tag | marker_tags(hash, block_index, "c")], {index, open, depth}}
  end

  defp inject_block_markers(tag, state, _hash), do: {[tag], state}

  # Wraps implicit keyword list.
  # {a: 1, b: 2} is not valid Elixir code, although {123, a: 1, b: 2} is allowed.
  defp normalize_implicit_keyword_list(templ_expr) do
    regex = ~r/^\{\s*(([a-zA-Z_][a-zA-Z0-9_]*[?!]?|"[^"]+"):\s.+)\}$/s

    case Regex.run(regex, templ_expr) do
      [_full, content, _beginning] ->
        "{[#{content}]}"

      nil ->
        templ_expr
    end
  end

  # Templates checked out on Windows carry CRLF line endings, which would otherwise give the same
  # template a different hash per platform, so markers could not be asserted verbatim.
  defp normalize_newlines(term) when is_binary(term) do
    StringUtils.normalize_newlines(term)
  end

  defp normalize_newlines(term) when is_list(term) do
    Enum.map(term, &normalize_newlines/1)
  end

  defp normalize_newlines(term) when is_tuple(term) do
    term
    |> Tuple.to_list()
    |> Enum.map(&normalize_newlines/1)
    |> List.to_tuple()
  end

  defp normalize_newlines(term), do: term

  defp render_attribute_code({:spread, templ_expr}, _tag_type) do
    "{:spread, #{normalize_implicit_keyword_list(templ_expr)}}"
  end

  defp render_attribute_code({name, value_parts}, :element) do
    value_code = Enum.map_join(value_parts, ", ", &render_code/1)

    case decompose_event_attribute_name(name) do
      {base_name, []} ->
        "{\"#{base_name}\", [#{value_code}]}"

      {base_name, modifiers} ->
        "{\"#{base_name}\", [#{value_code}], #{render_event_modifiers(base_name, modifiers)}}"
    end
  end

  defp render_attribute_code({name, value_parts}, _tag_type) do
    "{\"#{name}\", [" <> Enum.map_join(value_parts, ", ", &render_code/1) <> "]}"
  end

  defp render_code({:block_start, "else"}) do
    "] else ["
  end

  # Unstamped (the block is inside <script>/<style>, so add_block_markers/1 never gave it a hash
  # and index) or stamped but ineligible for a key plan - both compile to the same plain
  # comprehension as before this module existed. Neither is memoized: :none means positional
  # diffing (no cross-render item identity to key a cache on), and unstamped content has no
  # markers at all.
  defp render_code({:block_start, {"for", expr_str, :none, _guards}}) do
    "(for #{extract_expression_content(expr_str)} do ["
  end

  defp render_code({:block_start, {"for", expr_str, :none, _guards, _hash, _index}}) do
    "(for #{extract_expression_content(expr_str)} do ["
  end

  # Wraps the body list in a call to Marker.memoized_item/5, itself the middle element of a
  # 3-element array bracketed by the item's open and close markers. Both renderers already walk a
  # nested list recursively wherever they find one (the same mechanism that lets a "for" or "if"
  # block's own per-iteration/per-branch list sit inside its parent's children list unflattened),
  # so this needs no flattening of its own - the nesting resolves the same way it always has.
  #
  # Elixir-side memoized_item/5 is a transparent `item_fun.()`, so server-rendered output is
  # unchanged; the client twin (assets/js/elixir/hologram/template/marker.mjs) is where the actual
  # per-item cache lives, guarded by `guards` - see PLANNING notes on resolve_guards/3 for why that
  # list is restricted to names bound by this block or an enclosing "for", never "everything
  # referenced": a name out of scope at this call site is a compile error, not just a missed cache
  # hit.
  defp render_code({:block_start, {"for", expr_str, key_plan, guards, hash, index}}) do
    key_source = render_item_key_source(key_plan)
    guards_code = Enum.join(guards, ", ")

    ~s{(for #{extract_expression_content(expr_str)} do } <>
      ~s{holo__item_key__ = #{key_source}; } <>
      ~s{[Hologram.Template.Marker.item_node(holo__item_key__, "#{hash}", #{index}, "o"), } <>
      ~s{Hologram.Template.Marker.memoized_item(holo__item_key__, "#{hash}", #{index}, [#{guards_code}], fn -> [}
  end

  defp render_code({:block_end, "for"}) do
    "] end)"
  end

  defp render_code({:block_end, {"for", :none, _hash, _index}}) do
    "] end)"
  end

  defp render_code({:block_end, {"for", _key_plan, hash, index}}) do
    "] end), Hologram.Template.Marker.item_node(holo__item_key__, \"#{hash}\", #{index}, \"c\")] end)"
  end

  defp render_code({:block_start, {"if", expr_str}}) do
    "(if #{extract_expression_content(expr_str)} do ["
  end

  defp render_code({:block_end, "if"}) do
    "] end)"
  end

  # `raw` blocks are useful only in the handling of template sources.
  # `Parser` emits them so that such source can be reconstructed.
  # They can be skipped in the building of the AST here.
  defp render_code({:block_start, "raw"}) do
    :skip
  end

  defp render_code({:block_end, "raw"}) do
    :skip
  end

  defp render_code({:doctype, content}) do
    "{:doctype, \"#{content}\"}"
  end

  defp render_code({:end_tag, _tag_name}) do
    "]}"
  end

  defp render_code({:expression, templ_expr}) do
    "{:expression, #{normalize_implicit_keyword_list(templ_expr)}}"
  end

  defp render_code(:public_comment_end) do
    "]}"
  end

  defp render_code(:public_comment_start) do
    "{:public_comment, ["
  end

  defp render_code({:self_closing_tag, {tag_name, attributes}}) do
    render_code({:start_tag, {tag_name, attributes}}) <> render_code({:end_tag, tag_name})
  end

  # The tag name expression is already brace-wrapped, so emitting its source produces the one-tuple
  # holding the runtime value. Attributes use element-style event decomposition, since the element
  # branch is the only one that can consume events - the component branch filters them out anyway.
  defp render_code({:start_tag, {{:expression, templ_expr}, attributes}}) do
    attributes_code = Enum.map_join(attributes, ", ", &render_attribute_code(&1, :element))

    "{:dynamic_tag, #{templ_expr}, [#{attributes_code}], ["
  end

  defp render_code({:start_tag, {tag_name, attributes}}) do
    tag_type = Helpers.tag_type(tag_name)

    if tag_name in ["window", "document"] do
      validate_reserved_tag_attributes(tag_name, attributes)
    end

    tag_name_code =
      if tag_type == :element do
        "\"#{tag_name}\""
      else
        "alias!(#{tag_name})"
      end

    attributes_code =
      Enum.map_join(attributes, ", ", &render_attribute_code(&1, tag_type))

    "{:#{tag_type}, #{tag_name_code}, [#{attributes_code}], ["
  end

  defp render_code({:text, str}) do
    escaped_str =
      str
      |> HtmlEntities.decode()
      |> String.replace(~s("), ~s(\\"))

    ~s({:text, "#{escaped_str}"})
  end

  # Every event's raw segments are parsed and validated into tagged modifiers at compile time.
  defp render_event_modifiers(base_name, modifiers) do
    inspect(EventModifiers.parse(base_name, modifiers))
  end

  # {:auto, var_name} looks the bound item up by the generator's own variable name - valid because
  # auto-key only applies to a single plain-variable generator (see infer_auto_key_var/1), so that
  # name is always in scope in the body. {:explicit, key_expr} is a $key expression, already
  # extracted to plain source by handle_key_attr/3.
  defp render_item_key_source({:auto, var_name}) do
    "Hologram.Template.Marker.item_key(#{var_name})"
  end

  defp render_item_key_source({:explicit, key_expr}) do
    "Hologram.Template.Marker.key_from_value(#{key_expr})"
  end

  # Distinguishes markers belonging to different templates, since slot content is spliced into the
  # surrounding template's children and bare block indexes would collide there. Derived from the
  # tags rather than the module name so that it stays stable across renames and needs no caller
  # context. Two byte-identical templates share a hash, which degrades to marker churn rather than
  # element identity loss.
  #
  # :erlang.phash2/2 is documented to return the same value for a given term regardless of machine
  # architecture and ERTS version, which is what lets tests assert marker text verbatim.
  defp template_hash(tags) do
    tags
    |> normalize_newlines()
    |> :erlang.phash2(4_294_967_296)
    |> Integer.to_string(36)
    |> String.downcase()
  end

  defp substitute_module_attributes({:@, meta_1, [{name, _meta_2, _args}]}) do
    {{:., meta_1, [{:vars, meta_1, nil}, name]}, [{:no_parens, true} | meta_1], []}
  end

  defp substitute_module_attributes(ast) when is_list(ast) do
    Enum.map(ast, &substitute_module_attributes/1)
  end

  defp substitute_module_attributes(ast) when is_tuple(ast) do
    ast
    |> Tuple.to_list()
    |> Enum.map(&substitute_module_attributes/1)
    |> List.to_tuple()
  end

  defp substitute_module_attributes(ast), do: ast

  # The <window> and <document> tags bind events to the window or document and nothing else, so each
  # attribute must be an event binding (a "$"-prefixed name). Any other attribute fails the build.
  defp validate_reserved_tag_attributes(tag_name, attributes) do
    Enum.each(attributes, fn
      # Spread entries can't carry event bindings, since "$"-prefixed keys are rejected at runtime.
      {:spread, _templ_expr} ->
        raise TemplateSyntaxError,
          message: ~s'the <#{tag_name}> tag accepts only event bindings, but got a spread'

      {name, _value_parts} ->
        unless String.starts_with?(name, "$") do
          raise TemplateSyntaxError,
            message:
              ~s'the <#{tag_name}> tag accepts only event bindings, but got the "#{name}" attribute'
        end
    end)
  end
end
