defmodule Hologram.Template.MarkerTest do
  use Hologram.Test.BasicCase, async: true
  import Hologram.Template.Marker

  describe "item_key/1" do
    test "map with integer :id" do
      assert item_key(%{id: 1, name: "Alice"}) == "1"
    end

    test "map with binary :id" do
      assert item_key(%{id: "abc-def"}) == "abc-def"
    end

    test "map with atom :id" do
      assert item_key(%{id: :active}) == "active"
    end

    test "struct with :id" do
      assert item_key(Map.put(%URI{host: nil}, :id, 42)) == "42"
    end

    test "map without :id" do
      assert item_key(%{name: "Alice"}) == nil
    end

    test "not a map" do
      assert item_key("plain") == nil
      assert item_key(123) == nil
      assert item_key(nil) == nil
      assert item_key([1, 2, 3]) == nil
    end

    test "map with nil :id" do
      assert item_key(%{id: nil}) == nil
    end

    test "map with boolean :id" do
      assert item_key(%{id: true}) == nil
      assert item_key(%{id: false}) == nil
    end

    test "map with :id of an unsupported type" do
      assert item_key(%{id: 1.5}) == nil
      assert item_key(%{id: {1, 2}}) == nil
      assert item_key(%{id: %{nested: 1}}) == nil
    end
  end

  describe "key_from_value/1" do
    test "binary" do
      assert key_from_value("abc") == "abc"
    end

    test "integer" do
      assert key_from_value(42) == "42"
      assert key_from_value(-1) == "-1"
    end

    test "atom" do
      assert key_from_value(:active) == "active"
    end

    test "nil" do
      assert key_from_value(nil) == nil
    end

    test "boolean" do
      assert key_from_value(true) == nil
      assert key_from_value(false) == nil
    end

    test "float" do
      assert key_from_value(1.5) == nil
    end

    test "tuple" do
      assert key_from_value({1, 2}) == nil
    end

    test "list" do
      assert key_from_value([1, 2]) == nil
    end

    test "map" do
      assert key_from_value(%{a: 1}) == nil
    end

    test "empty binary" do
      assert key_from_value("") == nil
    end

    test "binary containing --" do
      assert key_from_value("a--b") == nil
    end

    test "binary at the max length" do
      key = String.duplicate("a", 128)
      assert key_from_value(key) == key
    end

    test "binary over the max length" do
      assert key_from_value(String.duplicate("a", 129)) == nil
    end

    test "binary with characters outside the allowed set" do
      assert key_from_value("a b") == nil
      assert key_from_value("a:b") == nil
      assert key_from_value("a<b") == nil
      assert key_from_value("a&b") == nil
      assert key_from_value(~s(a"b)) == nil
    end

    test "binary with all allowed non-alphanumeric characters" do
      assert key_from_value("a_b.c@d|e~f+g-h") == "a_b.c@d|e~f+g-h"
    end
  end

  describe "item_node/4" do
    test "with a key" do
      assert item_node("42", "abc123", 0, "o") == {:public_comment, [text: "[h:abc123:0:42:o]"]}
    end

    test "with a key, closing side" do
      assert item_node("42", "abc123", 0, "c") == {:public_comment, [text: "[h:abc123:0:42:c]"]}
    end

    test "without a key" do
      assert item_node(nil, "abc123", 0, "o") == nil
    end
  end
end
