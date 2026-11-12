/* ui.js を動かすための、最小の偽 DOM(依存を増やさないため自前)。ui.js が使う範囲だけ: 作成・子要素・属性・クラス・イベント・Shadow。 */
export class FakeEl {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
    this.children = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.parent = null;
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        (on === undefined ? !set.has(c) : on) ? set.add(c) : set.delete(c);
        self.className = [...set].join(" ");
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get textContent() {
    return this.children.length
      ? this.children.map((c) => c.textContent).join("")
      : this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n === this.doc.root || n.isRoot === true;
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  attachShadow() {
    this.shadow = new FakeEl("shadow-root", this.doc);
    this.shadow.parent = this;
    return this.shadow;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type) {
    if (this.disabled && type === "click") return;
    for (const fn of this.listeners.get(type) || []) fn({ target: this });
  }
  click() {
    this.dispatch("click");
  }
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
    if (this.shadow) this.shadow.walk(fn);
  }
  all(pred) {
    const out = [];
    this.walk((n) => {
      if (pred(n)) out.push(n);
    });
    return out;
  }
  querySelectorAll(sel) {
    if (/^[a-z]+$/i.test(sel))
      return this.all((n) => n.tagName === sel.toUpperCase() && n !== this);
    throw new Error("偽 DOM が対応していない selector: " + sel);
  }
}

export function makeDoc() {
  const doc = { created: [] };
  doc.createElement = (tag) => {
    const e = new FakeEl(tag, doc);
    doc.created.push(tag);
    return e;
  };
  doc.root = new FakeEl("html", doc);
  doc.root.isRoot = true;
  doc.documentElement = Object.assign(doc.root, {
    hasAttribute: (k) => doc.dark === true && k === "dark",
  });
  doc.body = new FakeEl("body", doc);
  doc.body.parent = doc.root;
  return doc;
}

export const byText = (root, text, tag) =>
  root.all(
    (n) =>
      (!tag || n.tagName === tag.toUpperCase()) &&
      n.children.length === 0 &&
      n.textContent === text,
  );
export const buttons = (root) => root.all((n) => n.tagName === "BUTTON");
export const buttonByText = (root, text) =>
  buttons(root).find(
    (b) => b.textContent === text || b.getAttribute("aria-label") === text,
  );
