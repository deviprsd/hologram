defmodule Hologram.Template.Marker do
  @moduledoc false

  # Runs on the hot path of every keyed `{%for}` iteration, so it is hand-ported to
  # assets/js/elixir/hologram/template/marker.mjs instead of being auto-transpiled - see
  # Hologram.Compiler.CallGraph.manually_ported_elixir_mfas/0. Keep both implementations in sync;
  # `key_from_value/1` in particular must accept and reject exactly the same values on both sides,
  # since a value one side rejects and the other accepts would give an item a "$key" attribute on
  # only one of server- and client-rendered output.

  # Excludes ":" so a key can't be mistaken for a segment separator in ItemCache's own
  # "hash:index:key" cache key (see item_cache.mjs), and "<", ">", "&", "\"", whitespace as a
  # conservative holdover from when this value could still reach an HTML comment unescaped. "-" is
  # kept for UUIDs; a run of "--" stays excluded for the same historical reason.
  @key_regex ~r/^[A-Za-z0-9_.@|~+-]+$/
  @max_key_length 128

  @doc """
  Returns the auto-key for a `{%for}` item: the string form of its `:id` field when the item is a
  map (structs included) carrying one, or `nil` otherwise. Called for every item of a `{%for}`
  whose generator is a single plain-variable pattern, regardless of what the item turns out to be
  - key selection happens at runtime per iteration, since only the runtime sees the item's real
  shape.
  """
  @spec item_key(term) :: String.t() | nil
  def item_key(%{id: id}), do: key_from_value(id)
  def item_key(_item), do: nil

  @doc """
  Validates and stringifies a key candidate - either an auto-key's `:id` value or an explicit
  `$key` expression's value. Only binaries, integers and non-boolean, non-nil atoms are accepted.
  Returns `nil` when the value can't safely become the key text - `add_slot_keys/2` (see
  `Hologram.Template.DOM`) then leaves the body's element with no "$key" attribute of its own, so
  it falls back to whichever ordinary key add_slot_keys/2 gives every other element, and the item
  loses its memoized_item/5 cache entry - the same positional diffing behaviour as before this
  module existed, silently, for that item alone. ":" is excluded so the key can't be mistaken for
  a segment separator in `ItemCache`'s own `"hash:index:key"` cache key (see item_cache.mjs); "-"
  is kept for UUIDs, with a run of "--" rejected separately as a defensive leftover from when this
  value could still reach an HTML comment unescaped.
  """
  @spec key_from_value(term) :: String.t() | nil
  def key_from_value(value) when is_binary(value), do: validate_key_text(value)

  def key_from_value(value) when is_integer(value) do
    validate_key_text(Integer.to_string(value))
  end

  def key_from_value(value) when is_atom(value) and not is_nil(value) and not is_boolean(value) do
    validate_key_text(Atom.to_string(value))
  end

  def key_from_value(_value), do: nil

  @doc """
  Wraps a keyed `{%for}` item's body. Semantically transparent on the BEAM - always calls
  `item_fun`, ignoring `key`/`hash`/`index`/`guards` - so server-rendered output is unchanged.
  The client twin (`assets/js/elixir/hologram/template/marker.mjs`) is where this actually caches
  the item's rendered DOM term by key, invalidating only when `guards` (the item's free variables,
  computed at compile time by `Hologram.Template.DOM`) changed since the last render.
  """
  @spec memoized_item(String.t() | nil, String.t(), non_neg_integer, list, (-> term)) :: term
  def memoized_item(_key, _hash, _index, _guards, item_fun), do: item_fun.()

  defp validate_key_text(text) do
    if byte_size(text) in 1..@max_key_length and
         not String.contains?(text, "--") and
         Regex.match?(@key_regex, text) do
      text
    else
      nil
    end
  end
end
