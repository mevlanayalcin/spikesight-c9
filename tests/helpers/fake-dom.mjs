// A small hand-written DOM for booting public/js/app.js under node --test (no browser, no
// packages). It implements only what the dashboard uses: an HTML tokenizer for index.html,
// elements with attributes, children, text, classList, dataset, style, form state and event
// listeners, and compound selectors (tag, #id, .class, [attr], [attr="value"]).
//
// It is deliberately strict where it matters for the tests: there is no HTML parsing on
// elements, so innerHTML, outerHTML and insertAdjacentHTML throw, and an unsupported selector
// throws instead of silently matching nothing.

const VOID_TAGS = new Set(["meta", "link", "input", "img", "br", "hr"]);
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": "\u00a0" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  list() {
    return this.element.className.split(/\s+/).filter(Boolean);
  }
  contains(name) {
    return this.list().includes(name);
  }
  add(...names) {
    const current = this.list();
    for (const name of names) if (!current.includes(name)) current.push(name);
    this.element.className = current.join(" ");
  }
  remove(...names) {
    this.element.className = this.list().filter((name) => !names.includes(name)).join(" ");
  }
  toggle(name, force) {
    const wanted = force === undefined ? !this.contains(name) : Boolean(force);
    if (wanted) this.add(name);
    else this.remove(name);
    return wanted;
  }
}

function parseSelector(selector) {
  const match = /^([a-zA-Z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(selector.trim());
  if (!match || selector.trim() === "") throw new Error(`fake-dom: unsupported selector "${selector}"`);
  const parsed = { tag: match[1] ? match[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
  for (const part of match[2].match(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ?? []) {
    if (part[0] === "#") parsed.id = part.slice(1);
    else if (part[0] === ".") parsed.classes.push(part.slice(1));
    else {
      const [, name, , value] = /^\[([\w-]+)(="([^"]*)")?\]$/.exec(part);
      parsed.attrs.push({ name, value: value === undefined ? null : value });
    }
  }
  return parsed;
}

export class FakeElement {
  constructor(tagName, ownerDocument, namespaceURI = null) {
    this.tagName = tagName;
    // HTML names are case-insensitive; namespaced (SVG) names such as feGaussianBlur keep their case.
    this.localName = namespaceURI === null ? tagName.toLowerCase() : tagName;
    this.namespaceURI = namespaceURI;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.className = "";
    this.id = "";
    this.ownText = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.selected = false;
    this.storedValue = undefined;
  }

  // ----- attributes -------------------------------------------------------
  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "id") this.id = text;
    else if (name === "class") this.className = text;
    else if (name === "value") this.storedValue = text;
    else if (name === "checked") this.checked = true;
    else if (name === "hidden") this.hidden = true;
    else if (name === "disabled") this.disabled = true;
    else if (name === "selected") this.selected = true;
    else if (name.startsWith("data-")) this.dataset[camel(name.slice(5))] = text;
  }
  getAttribute(name) {
    if (name === "class") return this.className === "" && !this.attributes.has("class") ? null : this.className;
    if (name === "id") return this.id === "" ? null : this.id;
    if (name.startsWith("data-")) {
      const key = camel(name.slice(5));
      return Object.prototype.hasOwnProperty.call(this.dataset, key) ? String(this.dataset[key]) : null;
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  // ----- form state -------------------------------------------------------
  get value() {
    if (this.storedValue !== undefined) return this.storedValue;
    if (this.localName === "select") {
      const options = this.querySelectorAll("option");
      const chosen = options.find((o) => o.selected) ?? options[0];
      return chosen ? chosen.value : "";
    }
    if (this.localName === "option" || this.localName === "textarea") return this.textContent;
    return "";
  }
  set value(next) {
    this.storedValue = String(next);
  }

  // ----- tree -------------------------------------------------------------
  get isText() {
    return this.localName === "#text";
  }
  get textContent() {
    if (this.isText) return this.ownText;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    const text = String(value);
    if (text !== "") this.append(text);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      let child = node;
      if (typeof node === "string") {
        child = new FakeElement("#text", this.ownerDocument);
        child.ownText = node;
      } else if (!(node instanceof FakeElement)) {
        throw new TypeError("fake-dom: append() accepts elements and strings only");
      }
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
      child.parentNode = this;
      this.children.push(child);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  /** Every element below this one, in document order (text nodes excluded). */
  descendants() {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.isText) continue;
        found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  // ----- selectors --------------------------------------------------------
  matches(selector) {
    const s = typeof selector === "string" ? parseSelector(selector) : selector;
    if (this.isText) return false;
    if (s.tag !== null && s.tag !== this.localName.toLowerCase()) return false;
    if (s.id !== null && s.id !== this.id) return false;
    for (const name of s.classes) if (!this.classList.contains(name)) return false;
    for (const { name, value } of s.attrs) {
      const actual = this.getAttribute(name);
      if (actual === null || (value !== null && actual !== value)) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const parsed = parseSelector(selector);
    return this.descendants().filter((node) => node.matches(parsed));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  // ----- events -----------------------------------------------------------
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
  }
  /** Call every listener for `type` and wait for the promises they return. */
  async dispatch(type, init = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...init };
    const results = [];
    for (const handler of [...(this.listeners.get(type) ?? [])]) results.push(handler.call(this, event));
    await Promise.all(results);
    return results.length;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  // ----- HTML parsing sinks are not available -----------------------------
  get innerHTML() {
    throw new Error("fake-dom: innerHTML is not available");
  }
  set innerHTML(_value) {
    throw new Error("fake-dom: innerHTML is not available");
  }
  get outerHTML() {
    throw new Error("fake-dom: outerHTML is not available");
  }
  set outerHTML(_value) {
    throw new Error("fake-dom: outerHTML is not available");
  }
  insertAdjacentHTML() {
    throw new Error("fake-dom: insertAdjacentHTML is not available");
  }
}

export class FakeDocument {
  constructor() {
    this.readyState = "complete";
    /** Every element made through createElement / createElementNS after parsing, in order. */
    this.created = [];
    /** The element that last received focus(), or null. */
    this.activeElement = null;
    this.root = new FakeElement("#document", this);
  }
  createElement(tagName) {
    const node = new FakeElement(String(tagName).toLowerCase(), this);
    this.created.push(node);
    return node;
  }
  createElementNS(namespaceURI, tagName) {
    const node = new FakeElement(String(tagName), this, namespaceURI);
    this.created.push(node);
    return node;
  }
  createTextNode(text) {
    const node = new FakeElement("#text", this);
    node.ownText = String(text);
    return node;
  }
  get documentElement() {
    return this.root.querySelector("html");
  }
  get body() {
    return this.root.querySelector("body");
  }
  getElementById(id) {
    return this.root.descendants().find((node) => node.id === id) ?? null;
  }
  querySelector(selector) {
    return this.root.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.root.querySelectorAll(selector);
  }
  write() {
    throw new Error("fake-dom: document.write is not available");
  }
}

const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
const ATTRIBUTE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Parse a hand-written HTML document into a FakeDocument. Throws on unbalanced tags. */
export function parseHtml(html) {
  const document = new FakeDocument();
  const stack = [document.root];
  let consumed = 0;
  for (const match of html.matchAll(TOKEN)) {
    if (match.index !== consumed) throw new Error(`fake-dom: cannot parse HTML near offset ${consumed}`);
    consumed = match.index + match[0].length;
    const [, closeTag, openTag, rawAttributes, selfClosing, textRun] = match;
    const parent = stack[stack.length - 1];
    if (closeTag) {
      if (parent.localName !== closeTag.toLowerCase()) throw new Error(`fake-dom: </${closeTag}> closes <${parent.localName}>`);
      stack.pop();
    } else if (openTag) {
      const node = new FakeElement(openTag.toLowerCase(), document);
      for (const attr of (rawAttributes ?? "").matchAll(ATTRIBUTE)) {
        node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
      }
      parent.append(node);
      if (!VOID_TAGS.has(node.localName) && selfClosing !== "/") stack.push(node);
    } else if (textRun !== undefined && textRun.trim() !== "") {
      parent.append(decode(textRun));
    }
  }
  if (consumed !== html.length) throw new Error(`fake-dom: cannot parse HTML near offset ${consumed}`);
  if (stack.length !== 1) throw new Error(`fake-dom: <${stack[stack.length - 1].localName}> is never closed`);
  return document;
}

/**
 * Install document, window and navigator on globalThis for one test file.
 * Returns { document, window, navigator, clipboard, restore }. `clipboard.writes` records every
 * writeText call. globalThis.fetch is left alone: tests replace it themselves.
 */
export function installFakeDom(html) {
  const document = parseHtml(html);
  const clipboard = {
    writes: [],
    async writeText(value) {
      this.writes.push(String(value));
    },
  };
  const navigator = { clipboard };
  const window = { document, navigator };
  const previous = {};
  for (const [name, value] of Object.entries({ document, window, navigator })) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
  }
  const restore = () => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  return { document, window, navigator, clipboard, restore };
}
