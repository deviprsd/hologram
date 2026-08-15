"use strict";

import {
  attributesModule,
  eventListenersModule,
  h as vnode,
  init,
} from "./vendor/snabbdom/build/index.js";

const patch = init([attributesModule, eventListenersModule]);

export default class Vdom {
  // "$key" never reaches server-rendered HTML - lib/hologram/template/renderer.ex's
  // render_attributes/1 rejects every "$"-prefixed attribute unconditionally, same as any event
  // binding - so there is nothing to recover here for an ordinary element; only a resource key
  // (link/script, derived from href/src/textContent, which are ordinary non-"$" attributes and do
  // reach the markup) is ever set on a boot-derived vnode. Ordinary elements fall back to
  // snabbdom's own keyless tag+position pairing for this first patch only - any later client-
  // driven render carries real "$key"s on both sides of its own diff (see renderer.mjs's
  // #renderSlotKey), which is where keyed reconciliation actually takes effect.
  static addKeysToVnodes(node) {
    let key;

    switch (node.sel) {
      case "link":
        if (
          node.data?.attrs?.href &&
          typeof node.data.attrs.href === "string"
        ) {
          key = `__hologramLink__:${node.data.attrs.href}`;
        }
        break;

      case "script":
        if (typeof node.data?.attrs?.src === "string" && node.data.attrs.src) {
          key = `__hologramScript__:${node.data.attrs.src}`;
        } else if (node.textContent) {
          // Make sure the script is executed if the code changes.
          key = `__hologramScript__:${node.textContent}`;
        }
        break;
    }

    if (key) {
      node.key = key;
      node.data.key = key;
    }

    if (Array.isArray(node.children)) {
      for (const childNode of node.children) {
        Vdom.addKeysToVnodes(childNode);
      }

      node.children = $.dedupeKeys(node.children);
    }
  }

  // Numbers repeats of a key within one children list, in document order: the second occurrence
  // becomes "<key>:1", the third "<key>:2".
  //
  // A key names a place in a template, and one place can be rendered into the same list more than
  // once - a loop's body, or the same component placed twice. Keys have to be unique among
  // siblings, since the diff indexes them by key and a repeat makes it reach for a node it has
  // already consumed.
  //
  // Every kind of key is numbered by the same rule, since every kind can repeat: the key an
  // element carries for its place, and the href or src a resource is named by.
  //
  // Only the vnode key is renumbered, never anything in the markup, so server-rendered and
  // client-rendered pages stay byte-identical. Both sides walk a children list in document order,
  // so both arrive at the same keys.
  static dedupeKeys(children) {
    // Nothing can repeat on its own, and a children list of one is the common case.
    if (children.length < 2) {
      return children;
    }

    const counts = new Map();

    for (const child of children) {
      if (!child?.key) {
        continue;
      }

      const count = counts.get(child.key) ?? 0;
      counts.set(child.key, count + 1);

      if (count > 0) {
        const dedupedKey = `${child.key}:${count}`;

        child.key = dedupedKey;
        child.data.key = dedupedKey;
      }
    }

    return children;
  }

  // Turns a complete children list into the form the diff works on: repeated keys numbered.
  //
  // This runs on the children of one element, never on a part of them: the keys a repeat gets
  // depend on what else the list holds, so numbering a loop's body on its own would give every
  // iteration the same keys, a block occurring once in the body however many times the body is
  // rendered.
  static finalizeChildren(children) {
    return $.dedupeKeys(children);
  }

  static from(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    return Vdom.#buildVnodeFromDomNode(doc.documentElement);
  }

  // Covered in feature tests
  static patchVirtualDocument(oldVirtualDocument, newVirtualDocument) {
    const newRootVNode = {
      // Keep the same selector (tag name, id, classes)
      sel: oldVirtualDocument.sel,
      // Update only the attributes
      data: {attrs: newVirtualDocument.data.attrs || {}},
      // Keep the same children
      children: oldVirtualDocument.children,
    };

    // Patch only the root vnode attributes
    const patchedVirtualDocument = patch(oldVirtualDocument, newRootVNode);

    // Then patch head and body separately to preserve JavaScript/CSS handling

    const oldHead = oldVirtualDocument.children.find($.#isHeadVnode);

    const newHead = newVirtualDocument.children.find($.#isHeadVnode);

    const oldBody = oldVirtualDocument.children.find($.#isBodyVnode);

    const newBody = newVirtualDocument.children.find($.#isBodyVnode);

    patchedVirtualDocument.children = oldVirtualDocument.children.map(
      (child) => {
        if ($.#isHeadVnode(child)) {
          return patch(oldHead, newHead);
        } else if ($.#isBodyVnode(child)) {
          return patch(oldBody, newBody);
        } else {
          return child;
        }
      },
    );

    return patchedVirtualDocument;
  }

  static #buildVnodeFromDomNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType === Node.COMMENT_NODE) {
      return vnode("!", node.textContent);
    }

    const children = $.dedupeKeys(
      Array.from(node.childNodes).map(Vdom.#buildVnodeFromDomNode),
    );

    const attrs = {};

    for (let attr of node.attributes) {
      attrs[attr.name] = attr.value === "" ? true : attr.value;
    }

    const tagName = node.tagName.toLowerCase();
    const data = {attrs: attrs};

    if (tagName === "link" && typeof attrs.href === "string") {
      data.key = `__hologramLink__:${attrs.href}`;
    } else if (
      tagName === "script" &&
      typeof attrs.src === "string" &&
      attrs.src
    ) {
      data.key = `__hologramScript__:${attrs.src}`;
    } else if (tagName === "script" && node.textContent) {
      // Make sure the script is executed if the code changes.
      data.key = `__hologramScript__:${node.textContent}`;
    }

    return vnode(tagName, data, children);
  }

  // We're checking html element children,
  // so the nodes are either: head element, body element or text (whitespace) nodes
  static #isBodyVnode(vnode) {
    return vnode.sel?.[0] === "b";
  }

  // We're checking html element children,
  // so the nodes are either: head element, body element or text (whitespace) nodes
  static #isHeadVnode(vnode) {
    return vnode.sel?.[0] === "h";
  }
}

const $ = Vdom;
