import { writeFileSync, mkdirSync } from "node:fs";
import { fakeApi } from "./fetch.mjs";
const { state, reset } = await import("./herdr-stub.mjs");
const { textOf } = await import("./gpui-stub.mjs");
const { default: Shortcut } = await import("../../mods/shortcut/main.js");

/** A view with this config and these API routes, initialised and (by default) settled. */
export async function open({ cfg = {}, routes = {}, props = {}, space = null, settle = true } = {}) {
  reset();
  state.props = { overlay: "ov1", ...props };
  if (space) state.spaces.push({ ...space, active: true });
  if (Object.keys(cfg).length) {
    mkdirSync(`${state.appHome}/data`, { recursive: true });
    writeFileSync(`${state.appHome}/data/shortcut.json`, JSON.stringify(cfg, null, 2));
  }
  const fetch = fakeApi(routes);
  globalThis.fetch = fetch;
  const pending = [];
  const cx = {
    timers: [],
    every: [],
    timer: { after: (ms, fn) => cx.timers.push({ ms, fn }), every: (ms, fn) => cx.every.push({ ms, fn }) },
    spawn: (fn) => { const p = fn(cx); pending.push(p); return p; },
    focus_handle: () => ({}),
    notify() {},
    stop_propagation() {},
    opened: [],
    clipboard: [],
    open_url: (url) => cx.opened.push(url),
    write_to_clipboard: (text) => cx.clipboard.push(text),
    settle: async () => { for (let i = 0; i < 6; i++) { await Promise.all(pending.splice(0)); await new Promise((r) => setImmediate(r)); } },
    fire: (ms) => { const due = cx.timers.filter((x) => x.ms === ms); cx.timers = cx.timers.filter((x) => x.ms !== ms); for (const t of due) t.fn(); },
  };
  const v = new Shortcut();
  v.init({}, cx);
  if (settle) await cx.settle();
  return { v, cx, fetch };
}

export const press = (v, cx, key, mods = {}) =>
  v.keys({ key, modifiers: { control: false, alt: false, shift: false, platform: false, ...mods } }, cx);

export const texts = (v) => textOf(v.render());
