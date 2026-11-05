// A stand-in for "gpui-kit" and "gpui-base": elements are plain objects that remember what they were given, so a
// test can render the picker and read back its text, icons and styles. Any styling method is accepted (and recorded);
// `when` runs its callback when the condition holds, as the real one does.
function make(tag, arg) {
  const el = { tag, arg, ops: [], kids: [] };
  const proxy = new Proxy(el, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === "symbol" || p === "then") return undefined;
      return (...a) => { t.ops.push([p, ...a]); return proxy; };
    },
  });
  el.child = (x) => { if (x != null && x !== false) el.kids.push(x); return proxy; };
  el.children = (list) => { for (const x of list ?? []) el.child(x); return proxy; };
  el.when = (cond, fn) => { if (cond) fn(proxy); return proxy; };
  el.hover = () => proxy;
  el.has = (name) => el.ops.some(([n]) => n === name);
  el.op = (name) => el.ops.find(([n]) => n === name)?.slice(1);
  return proxy;
}

export const div = () => make("div");
export const v_flex = () => make("v_flex");
export const h_flex = () => make("h_flex");
export const svg = (path) => make("svg", path);
export const image = (path) => make("image", path);
export const View = class {};
export const Scrollbar = { vertical: (id) => make("scrollbar", id) };
export class VirtualListScrollHandle { static new() { return new VirtualListScrollHandle(); } calls = []; scroll_to_item(index, strategy) { this.calls.push(strategy === undefined ? index : [index, strategy]); } }
export const v_virtual_list = (id, count, sizes, _key, renderRange) => {
  const el = make("virtual_list", id);
  el.sizes = sizes;
  el.children(renderRange({ start: 0, end: count }));
  return el;
};

export class InputState {
  constructor(o = {}) { this.v = o.value ?? ""; this.handlers = {}; this.placeholder = o.placeholder; }
  static new(o) { return new InputState(o); }
  on(name, fn) { this.handlers[name] = fn; }
  value() { return this.v; }
  set_value(v) { this.v = v; this.handlers.change?.({}, { notify() {}, spawn() {} }); }
  focus() {}
  emit(name) { this.handlers[name]?.({}, { notify() {}, spawn() {} }); }
}
export const Input = { new: (state) => make("input", state) };

export class TextareaState extends InputState {
  constructor(o = {}) { super(o); this.rows = o.rows; }
  static new(o) { return new TextareaState(o); }
  set_rows(n) { this.rows = n; }
  set_auto_grow(min, max) { this.grow = [min, max]; }
  set_soft_wrap() {}
}
export const Textarea = { new: (state) => make("textarea", state) };

/** All the text under an element, in order. */
export function textOf(el) {
  if (el == null) return "";
  if (typeof el === "string" || typeof el === "number") return String(el);
  return (el.kids ?? []).map(textOf).join("");
}
/** Every element under `el` (itself included) for which `test` holds. */
export function findAll(el, test, out = []) {
  if (el == null || typeof el !== "object") return out;
  if (test(el)) out.push(el);
  for (const k of el.kids ?? []) findAll(k, test, out);
  return out;
}
