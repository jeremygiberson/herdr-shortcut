// A stand-in for herdr's `herdr` module. exec runs real programs; the rest is a small fake of the app.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sc-herdr-"));

export const state = {
  home: join(root, "home"),
  appHome: join(root, "app"),
  spaces: [],
  panes: [],
  props: undefined,
  runs: [],
  overlays: [],
  closed: 0,
  commands: [],
  known: undefined,
};

let waiting = null;
let waits = 0;
const store = {};

export function reset() {
  Object.assign(state, { spaces: [], panes: [], props: undefined, runs: [], overlays: [], closed: 0, commands: [], known: undefined });
  waiting = null;
  for (const k of Object.keys(store)) delete store[k];
  for (const d of ["mods", "data"]) {
    rmSync(join(state.appHome, d), { recursive: true, force: true });
    mkdirSync(join(state.appHome, d), { recursive: true });
  }
  mkdirSync(state.home, { recursive: true });
}
reset();

export const pushCommand = (c) => {
  if (waiting) { const w = waiting; waiting = null; w(c); } else state.commands.push(c);
};
// How many times nextCommand was called: a spawn that calls it is a command loop, which never ends.
export const commandWaits = () => waits;
export const nextCommand = () => (waits++, state.commands.length ? Promise.resolve(state.commands.shift()) : new Promise((r) => { waiting = r; }));

export const home = () => state.home;
export const appHome = () => state.appHome;
export const spaces = () => state.spaces;
export const panes = () => state.panes;
export const props = () => state.props ?? {};
export const run = async (command, args) => { state.runs.push({ command, args }); return {}; };
export const openOverlay = (spec) => { state.overlays.push(spec); };
export const closeOverlay = () => { state.closed++; };
export const knownAgents = async () => state.known ?? [];
export const shared = (k) => store[k];
export const setShared = (k, v) => { store[k] = v; };

export function exec(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

export async function readTextFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
export async function writeTextFile(path, text, expected) {
  const now = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (now !== expected) throw new Error("the file changed since it was read");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return null;
}

const themeProxy = new Proxy({}, { get: (_t, k) => `#${String(k)}` });
export const theme = () => themeProxy;
