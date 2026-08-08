defmodule HologramFeatureTests.CompilerBugKeyedAttrBareCallTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.CompilerBugs.KeyedAttrBareCallPage

  # Repro for https://github.com/deviprsd/hologram/issues/13.
  #
  # STATUS (2026-08-08): both assertions PASS on this minimal page - the bug
  # does NOT reproduce here, on fresh AND incremental builds. The original
  # finding (Setu app, `Holoprint.Workspace.Row.row_class/1`) is unconfirmed
  # as to mechanism; something present in the real app's larger call graph
  # is the actual trigger, not the bare-call-as-keyed-attribute-value shape
  # alone. See the issue #13 comment thread for the full writeup.
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
