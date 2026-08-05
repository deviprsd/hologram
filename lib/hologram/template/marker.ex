defmodule Hologram.Template.Marker do
  @moduledoc false

  # Runs on the hot path of every keyed `{%for}` iteration, so it is hand-ported to
  # assets/js/elixir/hologram/template/marker.mjs instead of being auto-transpiled - see
  # Hologram.Compiler.CallGraph.manually_ported_elixir_mfas/0. Keep both implementations in sync;
  # `key_from_value/1` in particular must accept and reject exactly the same values on both sides,
  # since the same key text has to survive server-rendered markup and be reproduced identically by
  # the client renderer for the first patch after boot/navigation to agree with it.

  # Excludes ":" (the marker's own segment separator), "<", ">", "&", "\"" (unsafe inside an HTML
  # comment or requiring escaping the server side doesn't do for comment text) and whitespace.
  # "-" is kept for UUIDs; a run of "--" is rejected separately since it can close an HTML comment
  # early.
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
  `$key` expression's value. Only binaries, integers and non-boolean, non-nil atoms are accepted,
  since those are the terms that can become marker text without escaping. Returns `nil` when the
  value can't safely become marker text, which `item_node/4` turns into a plain (unkeyed) item -
  the same positional diffing behaviour as before this module existed.
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
  Builds one side of an item marker comment node - the client keys it exactly like a block marker
  (see `Hologram.Template.DOM.marker_tags/4`), except the marker text carries the item's key as an
  extra segment before the side. Returns `nil` when `key` is `nil`: both renderers drop `nil`
  children, so an unkeyable item emits no marker and no extra markup - the list falls back to
  positional diffing for that item alone, silently.
  """
  @spec item_node(String.t() | nil, String.t(), non_neg_integer, String.t()) :: tuple | nil
  def item_node(nil, _hash, _index, _side), do: nil

  def item_node(key, hash, index, side) do
    {:public_comment, [text: "[h:#{hash}:#{index}:#{key}:#{side}]"]}
  end

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
