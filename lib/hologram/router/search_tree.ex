defmodule Hologram.Router.SearchTree do
  @moduledoc false

  alias Hologram.Router.SearchTree

  defmodule Node do
    @moduledoc false

    defstruct value: nil, children: %{}

    @type t :: %__MODULE__{value: module | nil, children: %{String.t() => __MODULE__.t()}}
  end

  @doc """
  Adds route info for the given URL path to the search tree by creating all nodes related to that URL path.

  A trailing `:name?` segment (last segment only) is optional -- the page
  module is registered at both the path with that segment present and the
  path with it omitted, so one page module serves both e.g. `/orders` and
  `/orders/:id?`. Only the LAST segment may be marked optional; nothing here
  validates that (an earlier `:name?` is simply treated as a normal
  wildcard segment by `to_tree_segments/1`, since only `List.last/1` is
  checked).
  """
  @spec add_route(SearchTree.Node.t(), String.t(), module) :: SearchTree.Node.t()
  def add_route(search_tree, url_path, page_module) do
    raw_segments = raw_path_segments(url_path)

    if optional_trailing_segment?(List.last(raw_segments)) do
      without_optional_segment = List.delete_at(raw_segments, -1)

      search_tree
      |> insert_node(to_tree_segments(without_optional_segment), page_module)
      |> insert_node(to_tree_segments(raw_segments), page_module)
    else
      insert_node(search_tree, to_tree_segments(raw_segments), page_module)
    end
  end

  @doc """
  Matches the given URL path against the search tree.
  """
  @spec match_route(SearchTree.Node.t(), String.t()) :: atom | false
  def match_route(search_tree, url_path) do
    url_path_segments = url_path_segments(url_path)

    find_node(search_tree, url_path_segments) || false
  end

  defp find_node(current_node, tree_path)

  defp find_node(%{value: nil}, []), do: false

  defp find_node(%{value: value}, []), do: value

  defp find_node(%{children: children}, [head | tail]) do
    cond do
      children[head] -> find_node(children[head], tail)
      children["*"] -> find_node(children["*"], tail)
      true -> nil
    end
  end

  defp insert_node(current_node, tree_path, value)

  defp insert_node(current_node, [], value) do
    %{current_node | value: value}
  end

  defp insert_node(%{children: children} = current_node, [head | tail], value) do
    child = children[head] || %SearchTree.Node{}
    new_children = Map.put(children, head, insert_node(child, tail, value))
    %{current_node | children: new_children}
  end

  defp url_path_segments(url_path) do
    url_path
    |> raw_path_segments()
    |> to_tree_segments()
  end

  defp raw_path_segments(url_path) do
    url_path
    |> String.split("/")
    |> Enum.reject(&(&1 == ""))
  end

  defp to_tree_segments(segments) do
    Enum.map(segments, fn segment ->
      if String.starts_with?(segment, ":") do
        "*"
      else
        segment
      end
    end)
  end

  defp optional_trailing_segment?(nil), do: false

  defp optional_trailing_segment?(segment),
    do: String.starts_with?(segment, ":") and String.ends_with?(segment, "?")
end
