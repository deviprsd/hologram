defmodule HologramFeatureTests.CompilerBugs.KeyedAttrBareCallPage do
  use Hologram.Page

  # Repro for https://github.com/deviprsd/hologram/issues/13: a bare remote
  # call as the ENTIRE value of an attribute on a `{%for}` item's own
  # `$key`-bearing root element. `item_class/1` is called two ways on
  # purpose - bare, on the keyed div itself (expected broken per #13), and
  # wrapped in a string interpolation on a NON-keyed descendant `<span>`
  # inside it (expected fine, matching the issue's own "works two levels
  # down" observation) - both calls resolve the exact same function.
  route "/compiler-bugs/keyed-attr-bare-call"

  layout HologramFeatureTests.Components.DefaultLayout

  def init(_params, component, _server) do
    put_state(component, :items, [%{id: 1, label: "one"}, %{id: 2, label: "two"}])
  end

  def template do
    ~HOLO"""
    {%for item <- @items}
      <div id={"item-#{item.id}"} class={item_class(item)} $key={item.id}>
        <span class={"#{item_class(item)}"}>{item.label}</span>
      </div>
    {/for}
    """
  end

  def item_class(item), do: "item item--#{item.id}"
end
