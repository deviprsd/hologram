defmodule HologramFeatureTests.Events.KeyboardTest do
  use HologramFeatureTests.TestCase, async: true

  alias HologramFeatureTests.Events.KeyboardPage

  feature "key down", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> fill_in(css("#my_input_key_down"), with: "a")
    |> assert_text(
      css("#result"),
      ~r/\{:key_down, %\{event: %\{alt_key: false, code: "KeyA", ctrl_key: false, is_composing: false, key: "a", meta_key: false, repeat: false, selection_end: 0, selection_start: 0, shift_key: false\}\}\}/
    )
  end

  feature "key up", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> fill_in(css("#my_input_key_up"), with: "a")
    |> assert_text(
      css("#result"),
      ~r/\{:key_up, %\{event: %\{alt_key: false, code: "KeyA", ctrl_key: false, is_composing: false, key: "a", meta_key: false, repeat: false, selection_end: 1, selection_start: 1, shift_key: false\}\}\}/
    )
  end

  feature "typing is not blocked", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> fill_in(css("#my_input_key_down"), with: "abc")
    |> execute_script(
      "return document.querySelector('#my_input_key_down').value;",
      [],
      fn value -> assert value == "abc" end
    )
  end

  feature "single key filter", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> send_keys(css("#my_input_enter"), [:escape])
    |> assert_text(css("#result"), "nil")
    |> send_keys(css("#my_input_enter"), [:enter])
    |> assert_text(
      css("#result"),
      ~r/\{:enter, %\{event: %\{alt_key: false, code: "Enter", ctrl_key: false, is_composing: false, key: "Enter", meta_key: false, repeat: false, selection_end: 0, selection_start: 0, shift_key: false\}\}\}/
    )
  end

  feature "keys combo", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> send_keys(css("#my_input_ctrl_k"), ["k"])
    |> assert_text(css("#result"), "nil")
    |> send_keys(css("#my_input_ctrl_k"), [:control, "k"])
    |> assert_text(
      css("#result"),
      ~r/\{:ctrl_k, %\{event: %\{alt_key: false, code: "KeyK", ctrl_key: true, is_composing: false, key: "k", meta_key: false, repeat: false, selection_end: 1, selection_start: 1, shift_key: false\}\}\}/
    )
  end

  feature "key filters on key_down", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> send_keys(css("#my_input_key_down_arrow_up"), [:up_arrow])
    |> assert_text(
      css("#result"),
      ~r/\{:key_down_arrow_up, %\{event: %\{alt_key: false, code: "ArrowUp", ctrl_key: false, is_composing: false, key: "ArrowUp", meta_key: false, repeat: false, selection_end: 0, selection_start: 0, shift_key: false\}\}\}/
    )
  end

  feature "key filters on key_up", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> send_keys(css("#my_input_key_up_arrow_up"), [:up_arrow])
    |> assert_text(
      css("#result"),
      ~r/\{:key_up_arrow_up, %\{event: %\{alt_key: false, code: "ArrowUp", ctrl_key: false, is_composing: false, key: "ArrowUp", meta_key: false, repeat: false, selection_end: 0, selection_start: 0, shift_key: false\}\}\}/
    )
  end

  feature "special character filter", %{session: session} do
    session
    |> visit(KeyboardPage)
    |> send_keys(css("#my_input_slash"), ["/"])
    |> assert_text(
      css("#result"),
      ~r{\{:slash, %\{event: %\{alt_key: false, code: "Slash", ctrl_key: false, is_composing: false, key: "/", meta_key: false, repeat: false, selection_end: 0, selection_start: 0, shift_key: false\}\}\}}
    )
  end
end
