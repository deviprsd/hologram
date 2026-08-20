defmodule Hologram.Template.DOM do
  @moduledoc false

  alias Hologram.Commons.StringUtils
  alias Hologram.Compiler.AST
  alias Hologram.Template.EventModifiers
  alias Hologram.Template.Helpers
  alias Hologram.Template.Parser
  alias Hologram.TemplateSyntaxError

  # Tags a key would name nothing new. "document" and "window" render no node at all, and "slot"
  # renders whatever is put in its place. The three page-level elements are each the only one of
  # their kind, so a key cannot tell them from a sibling - and the patch reaches them by name
  # rather than through an ordinary children diff, which a key would make it refuse: the root is
  # rebuilt into a document that allows only one element, and head and body would be thrown away
  # and rebuilt on every navigation, taking the stylesheets and the scroll position with them.
  @unkeyable_tags ["body", "document", "head", "html", "slot", "window"]

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
    # The keys name places in this template, so they are built from the hash of the template as
    # written, before any of them has been added to it.
    hash = template_hash(tags)

    {code, _last_tag_type} =
      tags
      |> resolve_for_key_plans()
      |> add_slot_keys(hash)
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
  # that decision, since add_slot_keys/2 (which runs next) is where a keyed block's own item key
  # gets injected onto its body's first top-level element but has no way to look ahead at the
  # block's body to derive it.
  #
  # Runs as its own pass, before add_slot_keys/2, because deriving the decision needs a
  # different kind of lookahead than injecting a key does: injecting only needs to find the body's
  # first top-level element, while this needs to inspect the block's *body* - its generator shape, and whether one
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
      guard_refs: %{}
    }

    final_state = Enum.reduce(indexed_tags, initial_state, &scan_for_key_plan_tag/2)

    Enum.map(indexed_tags, fn {tag, index} ->
      apply_for_key_plan(tag, index, final_state)
    end)
  end

  # Rewrites a "for" block's own start tag to carry its resolved key plan and memoization guard
  # list. An author's own "$key" attribute (if any) is left exactly where it was written -
  # add_slot_keys/2 (which runs next) reads it from there directly instead of a hoisted variable,
  # and no longer strips it: upstream's own "$key"-is-not-an-event guard (ported alongside it,
  # see renderer.mjs's #buildEventBinding) means an unstripped "$key" no longer needs stripping to
  # avoid being read as a bogus "key" event.
  defp apply_for_key_plan({:block_start, {"for", expr_str}}, index, state) do
    {:block_start,
     {"for", expr_str, Map.fetch!(state.plans, index), Map.fetch!(state.guards, index)}}
  end

  defp apply_for_key_plan(tag, _index, _state), do: tag

  @doc """
  Names the template a key belongs to.

  Distinguishes a key from another template's, since slot content is spliced into the surrounding
  template's children and bare indexes would collide there. Derived from the tags rather than the
  module name so that it stays stable across renames and needs no caller context. Two byte-identical
  templates share a hash, which leaves their keys to be told apart by their position among siblings,
  the same way a loop's repeats are.

  `:erlang.phash2/2` is documented to return the same value for a given term regardless of machine
  architecture and ERTS version, which is what lets tests assert key text verbatim.
  """
  @spec template_hash(list(Parser.parsed_tag())) :: String.t()
  def template_hash(tags) do
    tags
    |> normalize_newlines()
    |> :erlang.phash2(4_294_967_296)
    |> Integer.to_string(36)
    |> String.downcase()
  end

  defp find_key_attr(attrs) do
    Enum.find(attrs, &match?({"$key", _value_parts}, &1))
  end

  # A for-frame's key_expr can only be set once a body tag is scanned, after the frame was already
  # pushed - so it's updated on the stack in place rather than threaded back through a return value
  # the way a stateless fold clause normally would.
  defp handle_key_attr(state, attrs) do
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

        %{state | for_stack: [%{frame | key_expr: key_expr} | rest]}
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

  defp scan_for_key_plan_tag({{:start_tag, {tag_name, attrs}}, _index}, state) do
    scanned_state =
      state
      |> scan_key_attr(attrs)
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
  defp scan_for_key_plan_tag({{:self_closing_tag, {tag_name, attrs}}, _index}, state) do
    state
    |> scan_key_attr(attrs)
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

  defp scan_key_attr(state, attrs) do
    case state.for_stack do
      [] ->
        if find_key_attr(attrs) do
          raise TemplateSyntaxError,
            message: ~s'the "$key" attribute is only allowed inside a "for" block'
        end

        state

      _frames ->
        handle_key_attr(state, attrs)
    end
  end

  # Gives every keyable element the key of the place it holds in this template, counted in source
  # order - a growing/shrinking "if"/"for" block can no longer shift a following sibling's
  # identity, since every element defends its own now, whatever happens around it. A "for" block
  # keyed by resolve_for_key_plans/1 (its own item identity, not this positional one) additionally
  # gets the computed per-item key injected onto the first top-level element of its body, and its
  # own start tag stamped with this template's hash and its own position - a stable identifier
  # memoized_item/5 needs as a cache key, independent of whichever body element (if any) ends up
  # carrying the item's own key.
  #
  # A keyed "for"'s body element gets the *item's* key instead of the positional one - injecting
  # both would leave two "$key" attributes on the same tag, and the reader (renderer.mjs's
  # #renderSlotKey) would silently let whichever was appended last shadow the other.
  defp add_slot_keys(tags, hash) do
    initial_state = %{next_index: 0, for_stack: [], element_depth: 0}

    {keyed_tags, _state} = Enum.map_reduce(tags, initial_state, &inject_slot_key(&1, &2, hash))

    keyed_tags
  end

  # Every "for" block gets a for_stack frame, keyed or not - a nested block reached only through
  # other blocks (an "if" wrapping a "for", say) never itself changes element_depth, so without a
  # frame for every "for" here (matching resolve_for_key_plans/1's own discipline) an inner keyed
  # "for"'s body could be mistaken for an outer one's merely because they happen to share a depth.
  defp inject_slot_key({:block_start, {"for", expr_str, :none, guards}}, state, _hash) do
    frame = %{key_plan: :none, entry_depth: state.element_depth, target_assigned: false}

    {{:block_start, {"for", expr_str, :none, guards}},
     %{state | for_stack: [frame | state.for_stack]}}
  end

  defp inject_slot_key({:block_start, {"for", expr_str, key_plan, guards}}, state, hash) do
    frame = %{key_plan: key_plan, entry_depth: state.element_depth, target_assigned: false}
    tag = {:block_start, {"for", expr_str, key_plan, guards, hash, state.next_index}}

    new_state = %{
      state
      | for_stack: [frame | state.for_stack],
        next_index: state.next_index + 1
    }

    {tag, new_state}
  end

  defp inject_slot_key({:block_end, "for"}, %{for_stack: [frame | rest]} = state, _hash) do
    tag = if frame.key_plan == :none, do: {:block_end, "for"}, else: {:block_end, {"for", :keyed}}
    {tag, %{state | for_stack: rest}}
  end

  defp inject_slot_key({:start_tag, {tag_name, attributes}}, state, hash) do
    {new_attributes, new_state} = key_attributes(tag_name, attributes, state, hash)
    {{:start_tag, {tag_name, new_attributes}}, bump_element_depth(new_state)}
  end

  defp inject_slot_key({:end_tag, _tag_name} = tag, state, _hash) do
    {tag, %{state | element_depth: state.element_depth - 1}}
  end

  defp inject_slot_key({:self_closing_tag, {tag_name, attributes}}, state, hash) do
    {new_attributes, new_state} = key_attributes(tag_name, attributes, state, hash)
    {{:self_closing_tag, {tag_name, new_attributes}}, new_state}
  end

  defp inject_slot_key(tag, state, _hash), do: {tag, state}

  defp bump_element_depth(state), do: %{state | element_depth: state.element_depth + 1}

  # Priority, never more than one: an author's own "$key" (explicit for-item key, already
  # validated and left in place by resolve_for_key_plans/1) > the nearest open keyed "for"'s
  # auto-derived item key, on its body's first top-level element only > the ordinary positional
  # key every other keyable element gets.
  defp key_attributes(tag_name, attributes, state, hash) do
    if keyable_tag?(tag_name) do
      cond do
        find_key_attr(attributes) ->
          {attributes, bump_index(state)}

        identity_key_frame(state) ->
          {attributes ++ [identity_key_attribute()],
           state |> mark_target_assigned() |> bump_index()}

        true ->
          {attributes ++ [slot_key_attribute(hash, state.next_index)], bump_index(state)}
      end
    else
      {attributes, state}
    end
  end

  defp bump_index(state), do: %{state | next_index: state.next_index + 1}

  defp identity_key_frame(%{for_stack: [frame | _]} = state) do
    if frame.key_plan != :none and not frame.target_assigned and
         frame.entry_depth == state.element_depth do
      frame
    end
  end

  defp identity_key_frame(_state), do: nil

  defp mark_target_assigned(%{for_stack: [frame | rest]} = state) do
    %{state | for_stack: [%{frame | target_assigned: true} | rest]}
  end

  # holo__item_key__ is bound by render_code/1's keyed "for" clause, in the same scope this
  # element's own DOM tuple gets built in - an ordinary expression attribute referencing a local
  # variable, no different from any author-written one.
  defp identity_key_attribute, do: {"$key", [{:expression, "{holo__item_key__}"}]}

  defp slot_key_attribute(hash, index), do: {"$key", [{:text, "#{hash}:#{index}"}]}

  defp keyable_tag?({:expression, _templ_expr}), do: true

  defp keyable_tag?(tag_name),
    do: Helpers.tag_type(tag_name) == :element and tag_name not in @unkeyable_tags

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
  # template a different hash per platform, so keys could not be asserted verbatim.
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

  # :none means positional diffing - no cross-render item identity to key a cache on, so nothing
  # to memoize, same plain comprehension as before "for" items could be keyed at all.
  defp render_code({:block_start, {"for", expr_str, :none, _guards}}) do
    "(for #{extract_expression_content(expr_str)} do ["
  end

  # Wraps the body list in a call to Marker.memoized_item/5. Both renderers already walk a nested
  # list recursively wherever they find one (the same mechanism that lets a "for" or "if" block's
  # own per-iteration/per-branch list sit inside its parent's children list unflattened), so this
  # needs no flattening of its own - the nesting resolves the same way it always has.
  #
  # Elixir-side memoized_item/5 is a transparent `item_fun.()`, so server-rendered output is
  # unchanged; the client twin (assets/js/elixir/hologram/template/marker.mjs) is where the actual
  # per-item cache lives, guarded by `guards` - see PLANNING notes on resolve_guards/3 for why that
  # list is restricted to names bound by this block or an enclosing "for", never "everything
  # referenced": a name out of scope at this call site is a compile error, not just a missed cache
  # hit. holo__item_key__ also reaches the DOM directly - add_slot_keys/2 injects it as the "$key"
  # attribute on the body's first top-level element, when there is one (see identity_key_frame/1).
  defp render_code({:block_start, {"for", expr_str, key_plan, guards, hash, index}}) do
    key_source = render_item_key_source(key_plan)
    guards_code = Enum.join(guards, ", ")

    ~s{(for #{extract_expression_content(expr_str)} do } <>
      ~s{holo__item_key__ = #{key_source}; } <>
      ~s{Hologram.Template.Marker.memoized_item(holo__item_key__, "#{hash}", #{index}, [#{guards_code}], fn -> [}
  end

  defp render_code({:block_end, "for"}) do
    "] end)"
  end

  # Closes the body list, the memoized_item/5 call's own trailing "fn -> ... end" argument, and
  # then the enclosing "for ... do ... end" the keyed :block_start clause above opened.
  defp render_code({:block_end, {"for", :keyed}}) do
    "] end) end)"
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
