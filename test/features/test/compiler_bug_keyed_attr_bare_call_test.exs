defmodule HologramFeatureTests.CompilerBugKeyedAttrBareCallTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.CompilerBugs.KeyedAttrBareCallPage

  # Repro for https://github.com/deviprsd/hologram/issues/13.
  #
  # No click needed - `{%for}` items render client-side on mount, so the
  # bare-call-as-keyed-attribute-value crash (if present) happens on page
  # load. Expected result if the issue reproduces: the first assertion
  # (against the item's own keyed div, `class={item_class(item)}` bare)
  # FAILS - `item_class/1` gets pruned from the bundle and rendering that
  # item throws client-side. The second assertion (the non-keyed inner
  # `<span>`, `class={"#{item_class(item)}"}` interpolated) is expected to
  # PASS regardless - same call, same target function, only the attribute
  # shape differs, isolating exactly what #13 says the trigger is.
  feature "a bare remote call as a keyed for-item's own attribute value still renders", %{
    session: session
  } do
    session = visit(session, KeyedAttrBareCallPage)

    assert_text(session, css("#item-1"), "one")
  end

  feature "control: the same call wrapped in a string interpolation, on a non-keyed descendant, renders",
          %{session: session} do
    session = visit(session, KeyedAttrBareCallPage)

    assert_text(session, css("#item-1 span"), "one")
  end
end
