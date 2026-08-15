"use strict";

import {
  assert,
  defineRuntimeGlobals,
  registerWebApis,
  vnode,
} from "./support/helpers.mjs";

import Vdom from "../../assets/js/vdom.mjs";

defineRuntimeGlobals();
registerWebApis();

describe("Vdom", () => {
  describe("addKeysToVnodes()", () => {
    it("element node that is not a link or script", () => {
      const node = vnode("img", {attrs: {src: "my_src"}}, []);
      Vdom.addKeysToVnodes(node);

      assert.deepStrictEqual(node, vnode("img", {attrs: {src: "my_src"}}, []));
    });

    it("text node", () => {
      const node = {
        sel: undefined,
        data: undefined,
        children: undefined,
        text: "my_text",
        elm: undefined,
        key: undefined,
      };

      Vdom.addKeysToVnodes(node);

      assert.deepStrictEqual(node, {
        sel: undefined,
        data: undefined,
        children: undefined,
        text: "my_text",
        elm: undefined,
        key: undefined,
      });
    });

    describe("comment node", () => {
      it("ordinary comment", () => {
        const node = vnode("!", "my comment");
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(node, vnode("!", "my comment"));
      });

      // "$key" never reaches server-rendered HTML (renderer.ex's render_attributes/1 strips every
      // "$"-prefixed attribute), so a comment recovered from the live DOM has nothing to key it -
      // even text that happens to look like the old marker format stays an ordinary, unkeyed
      // comment.
      it("comment text that looks like the old marker format", () => {
        const node = vnode("!", "[h:1a2b3c:0:o]");
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(node, vnode("!", "[h:1a2b3c:0:o]"));
      });
    });

    describe("link element", () => {
      it("without attrs field", () => {
        const node = vnode("link", {}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(node, vnode("link", {}, []));
      });

      it("without href attribute, but with some other attribute", () => {
        const node = vnode("link", {attrs: {rel: "stylesheet"}}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(
          node,
          vnode("link", {attrs: {rel: "stylesheet"}}, []),
        );
      });

      it("with boolean href attribute", () => {
        const node = vnode("link", {attrs: {href: true}}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(node, vnode("link", {attrs: {href: true}}, []));
      });

      it("with non-empty string href attribute", () => {
        const node = vnode("link", {attrs: {href: "my_link"}}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(
          node,
          vnode(
            "link",
            {
              key: "__hologramLink__:my_link",
              attrs: {href: "my_link"},
            },
            [],
          ),
        );
      });

      it("nested link nodes", () => {
        const node = vnode("div", {}, [
          vnode("link", {attrs: {href: "my_link_1"}}, []),
          vnode("img", {attrs: {src: "my_src"}}, []),
          vnode("link", {attrs: {href: "my_link_2"}}, []),
        ]);

        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(
          node,
          vnode("div", {}, [
            vnode(
              "link",
              {
                key: "__hologramLink__:my_link_1",
                attrs: {href: "my_link_1"},
              },
              [],
            ),
            vnode("img", {attrs: {src: "my_src"}}, []),
            vnode(
              "link",
              {
                key: "__hologramLink__:my_link_2",
                attrs: {href: "my_link_2"},
              },
              [],
            ),
          ]),
        );
      });
    });

    describe("script element", () => {
      it("without attrs field", () => {
        const node = vnode("script", {}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(node, vnode("script", {}, []));
      });

      it("without src attribute (inline script), but with some other attribute", () => {
        const node = vnode("script", {attrs: {type: "text/javascript"}}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(
          node,
          vnode("script", {attrs: {type: "text/javascript"}}, []),
        );
      });

      it("with boolean src attribute", () => {
        const node = vnode("script", {attrs: {src: true}}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(node, vnode("script", {attrs: {src: true}}, []));
      });

      it("with non-empty string src attribute", () => {
        const node = vnode("script", {attrs: {src: "my_src"}}, []);
        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(
          node,
          vnode(
            "script",
            {
              key: "__hologramScript__:my_src",
              attrs: {src: "my_src"},
            },
            [],
          ),
        );
      });

      it("nested script nodes", () => {
        const node = vnode("div", {}, [
          vnode("script", {attrs: {src: "my_src_1"}}, []),
          vnode("img", {attrs: {src: "my_src"}}, []),
          vnode("script", {attrs: {src: "my_src_2"}}, []),
        ]);

        Vdom.addKeysToVnodes(node);

        assert.deepStrictEqual(
          node,
          vnode("div", {}, [
            vnode(
              "script",
              {
                key: "__hologramScript__:my_src_1",
                attrs: {src: "my_src_1"},
              },
              [],
            ),
            vnode("img", {attrs: {src: "my_src"}}, []),
            vnode(
              "script",
              {
                key: "__hologramScript__:my_src_2",
                attrs: {src: "my_src_2"},
              },
              [],
            ),
          ]),
        );
      });
    });
  });

  describe("dedupeKeys()", () => {
    it("distinct keys", () => {
      const children = [
        vnode("li", {key: "abc123:0"}, []),
        vnode("li", {key: "abc123:1"}, []),
      ];

      Vdom.dedupeKeys(children);

      assert.deepStrictEqual(
        children.map((child) => child.key),
        ["abc123:0", "abc123:1"],
      );
    });

    it("repeated keys", () => {
      const children = [
        vnode("li", {key: "abc123:0"}, []),
        vnode("li", {key: "abc123:0"}, []),
        vnode("li", {key: "abc123:0"}, []),
      ];

      Vdom.dedupeKeys(children);

      assert.deepStrictEqual(
        children.map((child) => child.key),
        ["abc123:0", "abc123:0:1", "abc123:0:2"],
      );
    });

    it("renumbers the vnode key without touching anything else", () => {
      const children = [
        vnode("li", {key: "abc123:0", attrs: {"data-x": "y"}}, ["a"]),
        vnode("li", {key: "abc123:0", attrs: {"data-x": "y"}}, ["b"]),
      ];

      Vdom.dedupeKeys(children);

      assert.deepStrictEqual(
        children.map((child) => child.children[0].text),
        ["a", "b"],
      );

      assert.equal(children[1].data.key, "abc123:0:1");
      assert.equal(children[1].data.attrs["data-x"], "y");
    });

    it("unkeyed elements are left alone", () => {
      const children = [
        vnode("div", {attrs: {}}, []),
        vnode("div", {attrs: {}}, []),
      ];

      Vdom.dedupeKeys(children);

      assert.deepStrictEqual(
        children.map((child) => child.key),
        [undefined, undefined],
      );
    });

    // Every kind of key repeats through the same rule now - a "$key"-carrying element and a
    // resource-keyed script share one counter, unlike the old marker-only dedup.
    it("an element key and a resource key repeat through the same counter", () => {
      const children = [
        vnode("li", {key: "abc123:0"}, []),
        vnode("script", {key: "abc123:0", attrs: {src: "x.js"}}, []),
      ];

      Vdom.dedupeKeys(children);

      assert.deepStrictEqual(
        children.map((child) => child.key),
        ["abc123:0", "abc123:0:1"],
      );
    });

    it("a children list of one is returned unchanged", () => {
      const children = [vnode("li", {key: "abc123:0"}, [])];
      const result = Vdom.dedupeKeys(children);

      assert.equal(result, children);
    });
  });

  describe("finalizeChildren()", () => {
    it("delegates to dedupeKeys()", () => {
      const children = [
        vnode("li", {key: "abc123:0"}, []),
        vnode("li", {key: "abc123:0"}, []),
      ];

      Vdom.finalizeChildren(children);

      assert.deepStrictEqual(
        children.map((child) => child.key),
        ["abc123:0", "abc123:0:1"],
      );
    });
  });

  describe("from()", () => {
    it("builds virtual DOM from HTML markup", () => {
      const html =
        '<!DOCTYPE html><html lang="en" class="abc"><head></head><body><div attr1="abc" attr2></div><!-- my comment --><span>abc</span></body></html>';

      const result = Vdom.from(html);

      const expected = vnode("html", {attrs: {lang: "en", class: "abc"}}, [
        vnode("head", {attrs: {}}, []),
        vnode("body", {attrs: {}}, [
          vnode("div", {attrs: {attr1: "abc", attr2: true}}, []),
          vnode("!", " my comment "),
          vnode("span", {attrs: {}}, ["abc"]),
        ]),
      ]);

      assert.deepStrictEqual(result, expected);
    });

    // "$key" never reaches server-rendered HTML, so comment text that looks like the old marker
    // format stays plain, unkeyed comments - same as any other text a comment might carry.
    it("comment text that looks like the old marker format is never keyed", () => {
      const result = Vdom.from(
        "<html><body><!--[h:1a2b3c:0:o]--><!--[h:1a2b3c:0:o]--></body></html>",
      );

      const body = result.children[1];

      assert.deepStrictEqual(
        body.children.map((child) => child.key),
        [undefined, undefined],
      );
    });

    describe("link element vnode key", () => {
      it("not a link element", () => {
        const result = Vdom.from(
          '<html><body><a href="my_href"></a></body></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, []),
          vnode("body", {attrs: {}}, [
            vnode("a", {attrs: {href: "my_href"}}, []),
          ]),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("link element without href attribute", () => {
        const result = Vdom.from(
          '<html><head><link ref="stylesheet" /></head></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode("link", {attrs: {ref: "stylesheet"}}, []),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("link element with empty string href attribute", () => {
        const result = Vdom.from('<html><head><link href="" /></head></html>');

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode("link", {attrs: {href: true}}, []),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("link element with boolean href attribute", () => {
        const result = Vdom.from("<html><head><link href /></head></html>");

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode("link", {attrs: {href: true}}, []),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("link element with non-empty href attribute", () => {
        const result = Vdom.from(
          '<html><head><link href="my_href" /></head></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode(
              "link",
              {key: "__hologramLink__:my_href", attrs: {href: "my_href"}},
              [],
            ),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });
    });

    describe("script element vnode key", () => {
      it("not a script element", () => {
        const result = Vdom.from(
          '<html><body><img src="my_src" /></body></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, []),
          vnode("body", {attrs: {}}, [
            vnode("img", {attrs: {src: "my_src"}}, []),
          ]),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("script element without src attribute (inline script)", () => {
        const result = Vdom.from(
          '<html><head><script type="text/html"></script></head></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode("script", {attrs: {type: "text/html"}}, []),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("script element with empty string src attribute", () => {
        const result = Vdom.from(
          '<html><head><script src=""></script></head></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode("script", {attrs: {src: true}}, []),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("script element with boolean src attribute", () => {
        const result = Vdom.from(
          "<html><head><script src></script></head></html>",
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode("script", {attrs: {src: true}}, []),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("script element with non-empty src attribute", () => {
        const result = Vdom.from(
          '<html><head><script src="my_src"></script></head></html>',
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode(
              "script",
              {key: "__hologramScript__:my_src", attrs: {src: "my_src"}},
              [],
            ),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("script element with non-empty text content", () => {
        const result = Vdom.from(
          "<html><head><script>const x = 123;</script></head></html>",
        );

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [
            vnode(
              "script",
              {key: "__hologramScript__:const x = 123;", attrs: {}},
              ["const x = 123;"],
            ),
          ]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });

      it("script element with empty text content", () => {
        const result = Vdom.from("<html><head><script></script></head></html>");

        const expected = vnode("html", {attrs: {}}, [
          vnode("head", {attrs: {}}, [vnode("script", {attrs: {}}, [])]),
          vnode("body", {attrs: {}}, []),
        ]);

        assert.deepStrictEqual(result, expected);
      });
    });
  });
});
