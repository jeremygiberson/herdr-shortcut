import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { fakeApi } from "./fetch.mjs";
const { state, reset, commandWaits } = await import("./herdr-stub.mjs");
const { textOf } = await import("./gpui-stub.mjs");
const { default: Shortcut } = await import("../../mods/shortcut/main.js");

/** A view with this config and these API routes, initialised and (by default) settled. A cache file the test wrote
 *  before calling this is kept (call `reset` in a `beforeEach` to start each test without one). The API answers on a
 *  later turn of the event loop, so with `settle: false` the first render (from the cache) can be looked at. */
export async function open({ cfg = {}, routes = {}, props = {}, space = null, settle = true } = {}) {
  const cachePath = `${state.appHome}/data/shortcut-cache.json`;
  const cached = existsSync(cachePath) ? readFileSync(cachePath, "utf8") : null;
  reset();
  if (cached !== null) writeFileSync(cachePath, cached);
  state.props = { overlay: "ov1", ...props };
  if (space) state.spaces.push({ ...space, active: true });
  if (Object.keys(cfg).length) {
    mkdirSync(`${state.appHome}/data`, { recursive: true });
    writeFileSync(`${state.appHome}/data/shortcut.json`, JSON.stringify(cfg, null, 2));
  }
  const fetch = fakeApi(routes);
  globalThis.fetch = async (...a) => { await new Promise((r) => setImmediate(r)); return fetch(...a); };
  const pending = [];
  const cx = {
    timers: [],
    every: [],
    timer: { after: (ms, fn) => cx.timers.push({ ms, fn }), every: (ms, fn) => cx.every.push({ ms, fn }) },
    // A command loop never ends: settle would wait on it forever.
    spawn: (fn) => { const before = commandWaits(); const p = fn(cx); if (commandWaits() === before) pending.push(p); return p; },
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
  else await new Promise((r) => setImmediate(r)); // what init reads from disk, but no API answer yet
  return { v, cx, fetch };
}

export const press = (v, cx, key, mods = {}) =>
  v.keys({ key, modifiers: { control: false, alt: false, shift: false, platform: false, ...mods } }, cx);

export const texts = (v) => textOf(v.render());
