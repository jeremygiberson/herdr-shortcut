import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeRepo, scratch } from "./helpers/repo.mjs";
import { state, reset, exec, openOverlay, readTextFile } from "./helpers/herdr-stub.mjs";
const { normalize } = await import("../mods/shortcut/config.js");
const { buildLaunchRequest, backTo, spaceFolder, openLauncher, launcherReady } = await import("../mods/shortcut/launch.js");

beforeEach(reset);

test("buildLaunchRequest and backTo", () => {
  const story = { id: 7, name: "Fix", app_url: "https://x/7" };
  assert.deepEqual(buildLaunchRequest({ story, branch: "b", checkout: "new", prompt: "", hints: { names: [], urls: [], folder: null } }),
    { v: 1, branch: "b", checkout: "new", name: "sc-7 · Fix", prompt: null, source: { kind: "shortcut", id: "sc-7", url: "https://x/7", title: "Fix" }, repo: { names: [], urls: [], folder: null } });
  assert.deepEqual(backTo(story), { mod: "shortcut", props: { screen: "story", id: 7 } });
});
test("shipped: preflight needs a space in a git repo, then opens the worktree dialog", async () => {
  const repo = makeRepo(); const space = { id: "s1", folder: repo, tabs: [] };
  const got = await openLauncher({ cfg: normalize({}), launch: { v: 1, branch: "b", checkout: "new" }, back: null, space, panes: [], exec, openOverlay, readTextFile });
  assert.deepEqual(got, { ok: true, note: null });
  assert.deepEqual(state.overlays, [{ mod: "worktree", kind: "dialog", props: { folder: repo, machine: null, branch: "b", space: "s1" } }]);
  const none = await openLauncher({ cfg: normalize({}), launch: { v: 1, branch: "b" }, back: null, space: null, panes: [], exec, openOverlay, readTextFile });
  assert.equal(none.error, "Select a space in the repo first, or choose a launcher mod in settings");
  const notRepo = await openLauncher({ cfg: normalize({}), launch: { v: 1, branch: "b" }, back: null, space: { id: "s2", folder: scratch(), tabs: [] }, panes: [], exec, openOverlay, readTextFile });
  assert.equal(notRepo.error, "Select a space in the repo first, or choose a launcher mod in settings");
});
test("shipped: an existing branch that is not local gets a note", async () => {
  const repo = makeRepo();
  const got = await openLauncher({ cfg: normalize({}), launch: { v: 1, branch: "nowhere", checkout: "existing" }, back: null, space: { id: "s", folder: repo, tabs: [] }, panes: [], exec, openOverlay, readTextFile });
  assert.equal(got.note, "the shipped dialog can't fetch a remote-only branch");
});
test("mod launcher: must be installed, then gets launch and backTo as a dialog", async () => {
  const cfg = normalize({ launcher: { kind: "mod", name: "projects" } });
  const launch = { v: 1, branch: "b" }, back = { mod: "shortcut", props: {} };
  assert.deepEqual(await openLauncher({ cfg, launch, back, space: null, panes: [], exec, openOverlay, readTextFile }), { error: 'launcher "projects" is not installed' });
  mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, "");
  assert.deepEqual(await openLauncher({ cfg, launch, back, space: null, panes: [], exec, openOverlay, readTextFile }), { ok: true, note: null });
  assert.deepEqual(state.overlays.at(-1), { mod: "projects", kind: "dialog", width: 0.8, height: 0.8, props: { launch, backTo: back } });
});
test("spaceFolder prefers a live pane's cwd", () => {
  assert.equal(spaceFolder({ folder: "/f", tabs: [{ id: "t1" }] }, [{ tab: "t1", cwd: "/f/sub" }]), "/f/sub");
  assert.equal(spaceFolder({ folder: "/f", tabs: [] }, []), "/f");
});
test("launcherReady: a mod must be installed; the shipped one needs a selected space in a git repo", async () => {
  const mod = normalize({ launcher: { kind: "mod", name: "projects" } });
  assert.deepEqual(await launcherReady({ cfg: mod, space: null, panes: [], exec, readTextFile }), { error: 'launcher "projects" is not installed' });
  mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, "");
  assert.deepEqual(await launcherReady({ cfg: mod, space: null, panes: [], exec, readTextFile }), { ok: true });
  const shipped = normalize({});
  const NO = { error: "Select a space in the repo first, or choose a launcher mod in settings" };
  assert.deepEqual(await launcherReady({ cfg: shipped, space: null, panes: [], exec, readTextFile }), NO);
  assert.deepEqual(await launcherReady({ cfg: shipped, space: { id: "s", folder: scratch(), tabs: [] }, panes: [], exec, readTextFile }), NO);
  assert.deepEqual(await launcherReady({ cfg: shipped, space: { id: "s", folder: makeRepo(), tabs: [] }, panes: [], exec, readTextFile }), { ok: true });
});
