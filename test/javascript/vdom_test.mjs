"use strict";

import {
  assert,
  defineRuntimeGlobals,
  registerWebApis,
  vnode,
} from "./support/helpers.mjs";

import Vdom from "../../assets/js/vdom.mjs";

import {
  attributesModule,
  eventListenersModule,
  init,
} from "../../assets/js/vendor/snabbdom/build/index.js";

defineRuntimeGlobals();
registerWebApis();

describe("Vdom", () => {
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

  describe("mirror()", () => {
    // The same patch production builds, so these stand for the boot patch rather than a
    // differently configured one.
    const patch = init([attributesModule, eventListenersModule]);

    const mount = (html) => {
      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.appendChild(container);

      return container;
    };

    // Mirror against the container, then run the boot patch the way render() will: the mirrored
    // tree as the old side, the rendered tree as the new one.
    const adopt = (renderedChildren, html) => {
      const container = mount(html);
      const rendered = vnode("div", {attrs: {}}, renderedChildren);
      const mirrored = Vdom.mirror(rendered, container);

      return {container, mirrored, patched: () => patch(mirrored, rendered)};
    };

    it("adopts a matching tree, copying sel and key from the rendered side", () => {
      const container = mount('<div id="app"><p>hello</p></div>');

      const rendered = vnode("div", {attrs: {id: "app"}, key: "my_key"}, [
        vnode("p", {attrs: {}}, ["hello"]),
      ]);

      const mirrored = Vdom.mirror(rendered, container.firstChild);

      assert.equal(mirrored.sel, "div");
      assert.equal(mirrored.key, "my_key");
      assert.deepStrictEqual(mirrored.data.attrs, {id: "app"});
      assert.equal(mirrored.elm, container.firstChild);

      const [p] = mirrored.children;
      assert.equal(p.sel, "p");
      assert.equal(p.elm, container.firstChild.firstChild);
      assert.equal(p.children[0].text, "hello");
      assert.equal(p.children[0].elm, p.elm.firstChild);
    });

    it("keeps the server's nodes through the boot patch and attaches listeners", () => {
      let clicks = 0;

      const {container, patched} = adopt(
        [vnode("button", {attrs: {}, on: {click: () => clicks++}}, ["go"])],
        "<button>go</button>",
      );

      const serverButton = container.querySelector("button");
      patched();

      assert.equal(container.querySelector("button"), serverButton);

      serverButton.dispatchEvent(new window.Event("click"));
      assert.equal(clicks, 1);
    });

    it("syncs attributes to the rendered side without replacing the node", () => {
      const {container, patched} = adopt(
        [vnode("p", {attrs: {class: "fresh"}}, [])],
        '<p class="stale" data-junk="1"></p>',
      );

      const serverP = container.querySelector("p");
      patched();

      assert.equal(container.querySelector("p"), serverP);
      assert.equal(serverP.getAttribute("class"), "fresh");
      assert.isFalse(serverP.hasAttribute("data-junk"));
    });

    it("adopts a text node whose content differs and patches it in place", () => {
      const {container, patched} = adopt(
        [vnode("p", {attrs: {}}, ["fresh"])],
        "<p>stale</p>",
      );

      const serverText = container.querySelector("p").firstChild;
      patched();

      assert.equal(container.querySelector("p").firstChild, serverText);
      assert.equal(serverText.textContent, "fresh");
    });

    it("replaces a subtree whose tag diverges", () => {
      const {container, patched} = adopt(
        [vnode("div", {attrs: {}}, [])],
        "<span>old</span>",
      );

      const serverSpan = container.querySelector("span");
      patched();

      assert.isNull(container.querySelector("span"));
      assert.notEqual(container.querySelector("div"), serverSpan);
      assert.equal(container.firstChild.tagName, "DIV");
    });

    it("removes DOM nodes the rendered side doesn't know about", () => {
      const {container, patched} = adopt(
        [vnode("p", {attrs: {}}, [])],
        "<p></p><i>injected</i>",
      );

      patched();

      assert.isNull(container.querySelector("i"));
      assert.equal(container.childNodes.length, 1);
    });

    it("creates rendered nodes with no DOM counterpart", () => {
      const {container, patched} = adopt(
        [vnode("p", {attrs: {}}, []), vnode("em", {attrs: {}}, [])],
        "<p></p>",
      );

      const serverP = container.querySelector("p");
      patched();

      assert.equal(container.querySelector("p"), serverP);
      assert.equal(container.querySelector("em").tagName, "EM");
    });

    // The boot render omits the runtime's own scripts: they are guarded by page_mounted?, which
    // the server sets to true in the struct it serializes to the client. So the render is not a
    // node-for-node prefix of the head, and the stylesheet after those scripts still has to be
    // adopted rather than re-fetched.
    it("passes over nodes the render omits and adopts what follows", () => {
      const {container, patched} = adopt(
        [
          vnode("meta", {attrs: {charset: "utf-8"}}, []),
          vnode(
            "link",
            {
              key: "__hologramLink__:/app.css",
              attrs: {rel: "stylesheet", href: "/app.css"},
            },
            [],
          ),
          vnode("style", {attrs: {}}, ["body { color: red; }"]),
        ],
        '<meta charset="utf-8">' +
          "<script>globalThis.Hologram = {}</script>" +
          '<script src="/hologram/runtime.js"></script>' +
          '<link rel="stylesheet" href="/app.css">' +
          "<style>body { color: red; }</style>",
      );

      const serverMeta = container.querySelector("meta");
      const serverLink = container.querySelector("link");
      const serverStyle = container.querySelector("style");

      patched();

      assert.equal(container.querySelector("meta"), serverMeta);
      assert.equal(container.querySelector("link"), serverLink);
      assert.equal(container.querySelector("style"), serverStyle);
      assert.equal(container.querySelectorAll("script").length, 0);

      // A node mirrored as itself has to report its children truthfully, or the patch appends
      // content it already holds.
      assert.equal(serverStyle.textContent, "body { color: red; }");
    });

    // The shape the root has on every page: the parser puts the whitespace between </head> and
    // <body> inside <html>, so the rendered text that comes before an element finds a text node
    // only after it. A text node stands for any other, so a text vnode allowed to look ahead would
    // take that one and pass over the element in between - the whole head, in the real document.
    it("does not let a text node take one further along", () => {
      // The element carries the key of its place, the way every rendered element does. A node
      // mirrored as itself carries none, so the two no longer match and the patch rebuilds it.
      const {container, patched} = adopt(
        [" ", vnode("p", {attrs: {}, key: "my_key"}, ["hello"])],
        "<p>hello</p> ",
      );

      const serverP = container.querySelector("p");
      patched();

      assert.equal(container.querySelector("p"), serverP);
    });

    it("does not adopt a script element for a different source", () => {
      const {container, patched} = adopt(
        [
          vnode(
            "script",
            {
              key: "__hologramScript__:/fresh.js",
              attrs: {src: "/fresh.js"},
            },
            [],
          ),
        ],
        '<script src="/stale.js"></script>',
      );

      const serverScript = container.querySelector("script");
      patched();

      // Adopting would have left the stale code running, since changing src on a script that has
      // already executed does not run the new one.
      assert.notEqual(container.querySelector("script"), serverScript);
      assert.equal(
        container.querySelector("script").getAttribute("src"),
        "/fresh.js",
      );
    });

    it("keeps a script whose rendered key matches, so it is not re-executed", () => {
      const rendered = vnode(
        "script",
        {key: "__hologramScript__:my_src", attrs: {src: "my_src"}},
        [],
      );

      const {container, patched} = adopt(
        [rendered],
        '<script src="my_src"></script>',
      );

      const serverScript = container.querySelector("script");
      patched();

      assert.equal(container.querySelector("script"), serverScript);
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
