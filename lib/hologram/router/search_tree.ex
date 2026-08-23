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

  A trailing RUN of `:name?` segments is optional -- the page module is
  registered at every prefix from the mandatory segments alone up through
  the full path, so one page module serves e.g. `/stock`, `/stock/:id`,
  and `/stock/:id/:panel` for `route "/stock/:id?/:panel?"`.

  Optional segments must be a contiguous run at the very end of the route.
  A mandatory segment may never follow an optional one -- `/x/:id?/edit`
  raises, since there's no single coherent search-tree entry for "`:id`
  present, `edit` still required" vs. "`:id` absent, `edit` still
  required" (those are two different route shapes, not one route with an
  optional middle).
  """
  @spec add_route(SearchTree.Node.t(), String.t(), module) :: SearchTree.Node.t()
  def add_route(search_tree, url_path, page_module) do
    raw_segments = raw_path_segments(url_path)
    optional_count = count_trailing_optional_segments!(raw_segments, url_path)
    mandatory_count = length(raw_segments) - optional_count

    Enum.reduce(0..optional_count, search_tree, fn included_optional_count, acc ->
      prefix = Enum.take(raw_segments, mandatory_count + included_optional_count)
      insert_node(acc, to_tree_segments(prefix), page_module)
    end)
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

  defp optional_trailing_segment?(segment),
    do: String.starts_with?(segment, ":") and String.ends_with?(segment, "?")

  # Validates that every optional (`:name?`) segment forms the exact
  # trailing suffix of `segments` -- no gaps, nothing mandatory after the
  # first optional one -- and returns how many there are. Raises otherwise:
  # a non-trailing optional segment would silently mis-register (this
  # function is what makes that impossible instead of a footgun).
  defp count_trailing_optional_segments!(segments, url_path) do
    optional_indices =
      segments
      |> Enum.with_index()
      |> Enum.filter(fn {segment, _index} -> optional_trailing_segment?(segment) end)
      |> Enum.map(fn {_segment, index} -> index end)

    expected_indices =
      Enum.to_list((length(segments) - length(optional_indices))..(length(segments) - 1)//1)

    unless optional_indices == expected_indices do
      raise ArgumentError,
            "optional route segments (`:name?`) must form an unbroken run at the end of the " <>
              "route, got: #{inspect(url_path)}"
    end

    length(optional_indices)
  end
end
