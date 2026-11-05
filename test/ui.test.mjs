import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { open, press, texts } from "./helpers/view.mjs";
import { state, reset, pushCommand } from "./helpers/herdr-stub.mjs";
import { WF, S, basic } from "./helpers/fixtures.mjs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { makeRepo, sh } from "./helpers/repo.mjs";
const { readCache, writeCache } = await import("../mods/shortcut/api.js");
const { dataPath } = await import("../mods/shortcut/config.js");

// Each test starts on Mine: the tab chosen is kept in localStorage, which outlives a test.
beforeEach(() => { reset(); localStorage.clear(); });
test("the popup renders its title", async () => {
  const { v } = await open({ routes: { "GET /member": { status: 401, body: { message: "Unauthorized" } } } });
  assert.match(texts(v), /Shortcut/);
  assert.equal(localStorage.getItem("nope"), null);
});

test("Mine renders the stories grouped by state, from the API", async () => {
  const { v, fetch } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  const t = texts(v);
  assert.match(t, /Ready[\s\S]*sc-1[\s\S]*Alpha/); assert.match(t, /In Dev[\s\S]*sc-2[\s\S]*Beta/);
  const search = fetch.calls.find((c) => c.path === "/stories/search");
  assert.deepEqual(search.body, { owner_ids: ["me"], workflow_state_types: ["unstarted", "started"], archived: false });
});
test("the cache renders first, then the refresh replaces it", async () => {
  await writeCache({ member: { at: Date.now(), data: { id: "me", mention_name: "jer" } }, workflows: { at: Date.now(), data: [WF] }, lists: { mine: { at: 0, data: [S(5, "Cached", 11)] } } });
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic(), settle: false });
  assert.match(texts(v), /Cached/);
  await cx.settle();
  assert.doesNotMatch(texts(v), /Cached/); assert.match(texts(v), /Alpha/);
});
test("no token shows sign-in naming the variable", async () => {
  const { v } = await open({ cfg: { auth: { env: "SC_UNSET_X" } }, routes: basic() });
  assert.equal(v.screen, "signIn"); assert.match(texts(v), /SC_UNSET_X/);
});
test("401 shows sign-in and keeps the list cache", async () => {
  await writeCache({ member: { at: Date.now(), data: { id: "me", mention_name: "jer" } }, lists: { mine: { at: 0, data: [S(5, "Cached", 11)] } } });
  // Every call is refused: the cached member is fresh, so the first call made is not /member.
  const refused = Object.fromEntries(Object.keys(basic()).map((k) => [k, { status: 401, body: { message: "Unauthorized" } }]));
  const { v } = await open({ cfg: { auth: { token: "bad" } }, routes: refused });
  assert.equal(v.screen, "signIn");
  assert.deepEqual((await readCache()).lists.mine.data.map((s) => s.id), [5]);
  assert.equal((await readCache()).member, undefined);
});
test("the filter narrows, and a story key looks it up workspace-wide", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /stories/42": S(42, "Far away", 11) } });
  v.input.set_value("beta"); assert.deepEqual(v.shownRows().filter((r) => r.story).map((r) => r.story.id), [2]);
  v.input.set_value("sc-42"); await cx.settle();
  assert.equal(v.shownRows()[0]?.story?.id, 42);
});
test("a text filter with no local match searches the workspace; a failed refresh keeps the cache with a note", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /search/stories": { data: [S(8, "Zeta far", 11)], next: null } } });
  v.input.set_value("zeta"); cx.fire(400); await cx.settle();
  assert.match(texts(v), /Workspace[\s\S]*sc-8/);
  await writeCache({ member: { at: Date.now(), data: { id: "me", mention_name: "jer" } }, workflows: { at: Date.now(), data: [WF] }, lists: { mine: { at: 0, data: [S(5, "Cached", 11)] } } });
  const down = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "POST /stories/search": { status: 503, body: {} } } });
  assert.match(texts(down.v), /Cached/); assert.match(down.v.err, /^offline, showing cached/);
});
test("Esc closes from the list, and the footer lists the keys", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  assert.match(texts(v), /start/); assert.match(texts(v), /settings/);
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 1);
});
test("Esc with a filter clears it and stays, whether or not the filter has the keyboard", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  v.input.set_value("beta"); v.found = { id: 1 }; v.searched = { query: "beta", data: [] }; v.at = 3;
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 0);
  assert.equal(v.filter, ""); assert.equal(v.input.value(), ""); assert.equal(v.found, null); assert.equal(v.searched, null); assert.equal(v.at, 0);
  v.input.emit("focus"); v.input.set_value("alpha");
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 0); assert.equal(v.filter, "");
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 1);
});
test("Esc with an empty filter closes, even while the filter has the keyboard", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  v.input.emit("focus"); assert.equal(v.filter, "");
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 1);
});
test("a command handler that throws shows the error and the next command still works", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  const orig = v.escape;
  v.escape = () => { v.escape = orig; throw new Error("boom"); };
  pushCommand("escape"); await cx.settle();
  assert.match(v.err, /command: boom/); assert.match(texts(v), /boom/); assert.equal(state.closed, 0);
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 1);
});
test("Team lists my first group's started stories and offers a chooser when I'm in several", async () => {
  const routes = { ...basic(), "GET /groups": [{ id: "g1", name: "Eng", member_ids: ["me"], archived: false }, { id: "g2", name: "Data", member_ids: ["me"], archived: false }] };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes });
  press(v, cx, "2"); await cx.settle();
  assert.equal(v.tab, "team");
  assert.deepEqual(fetch.calls.filter((c) => c.path === "/stories/search").at(-1).body, { group_ids: ["g1"], workflow_state_types: ["started"], archived: false });
  assert.match(texts(v), /Eng/); assert.match(texts(v), /Data/);
});
test("Epics drill into an epic's stories and Esc comes back", async () => {
  const routes = { ...basic(), "GET /epics": [{ id: 3, name: "Big", archived: false, completed: false }] };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes });
  press(v, cx, "3"); await cx.settle(); assert.match(texts(v), /Big/);
  v.input.emit("submit"); await cx.settle();
  assert.deepEqual(fetch.calls.filter((c) => c.path === "/stories/search").at(-1).body, { epic_ids: [3], archived: false });
  pushCommand("escape"); await cx.settle(); assert.equal(v.drilled, null); assert.equal(state.closed, 0);
});
test("Recent shows the settings' recent stories newest first, archived dimmed", async () => {
  const routes = { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "GET /stories/9": { ...S(9, "Old", 14), archived: true } };
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, recent: [{ id: 1, at: "2026-11-04T10:00:00Z" }, { id: 9, at: "2026-11-01T10:00:00Z" }] }, routes });
  press(v, cx, "4"); await cx.settle();
  assert.deepEqual(v.shownRows().filter((r) => r.story).map((r) => r.story.id), [1, 9]);
});
const G = (id, name, members = ["me"]) => ({ id, name, member_ids: members, archived: false });
test("Team with a single group shows no chooser", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /groups": [G("g1", "Eng"), G("g2", "Other", ["x"])] } });
  press(v, cx, "2"); await cx.settle();
  assert.doesNotMatch(texts(v), /Other/);
});
test("in no group the Team tab says so and does not search", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /groups": [G("g2", "Other", ["x"])] } });
  const before = fetch.calls.filter((c) => c.path === "/stories/search").length;
  press(v, cx, "2"); await cx.settle();
  assert.match(texts(v), /You are in no team\./);
  assert.equal(fetch.calls.filter((c) => c.path === "/stories/search").length, before);
});
test("Recent draws an archived story with an archived chip and skips ids that fail", async () => {
  const routes = { ...basic(), "GET /stories/9": { ...S(9, "Old", 14), archived: true }, "GET /stories/5": S(5, "Fine", 11) };
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, recent: [{ id: 9, at: "a" }, { id: 7, at: "b" }, { id: 5, at: "c" }] }, routes });
  press(v, cx, "4"); await cx.settle();
  assert.deepEqual(v.shownRows().filter((r) => r.story).map((r) => r.story.id), [9, 5]);
  assert.match(texts(v), /archived/);
});
test("Recent never resolves a story id to an epic with the same id", async () => {
  // Mine is empty, so story 1 is not already in a list (Recent would reuse that copy).
  const routes = { ...basic(), "GET /epics": [{ id: 1, name: "EpicOne", archived: false, completed: false }], "GET /stories/1": S(1, "StoryOne", 11), "POST /stories/search": { data: [], next: null } };
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, recent: [{ id: 1, at: "a" }] }, routes });
  press(v, cx, "3"); await cx.settle();
  press(v, cx, "4"); await cx.settle();
  assert.deepEqual(v.shownRows().filter((r) => r.story).map((r) => r.story.name), ["StoryOne"]);
});
test("a drilled epic is titled and Esc leaves the filter alone", async () => {
  const routes = { ...basic(), "GET /epics": [{ id: 3, name: "Big", archived: false, completed: false }] };
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes });
  press(v, cx, "3"); await cx.settle();
  v.input.set_value("big"); v.input.emit("submit"); await cx.settle();
  assert.match(texts(v), /Epic · Big/);
  pushCommand("escape"); await cx.settle();
  assert.equal(v.drilled, null); assert.equal(v.filter, "big");
});
test("Enter opens a story with its fields, and Esc returns to its row", async () => {
  const routes = { ...basic(), "GET /stories/2": { ...S(2, "Beta", 12), description: "Para one.\n\nPara two.", labels: [{ name: "bug" }], pull_requests: [{ number: 5, title: "PR", url: "https://github.com/o/r/pull/5", merged: false, closed: false, draft: false, branch_name: "jer/sc-2/beta" }] } };
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes });
  v.at = v.shownRows().findIndex((r) => r.story?.id === 2); v.input.emit("submit"); await cx.settle();
  assert.equal(v.screen, "story");
  const t = texts(v); assert.match(t, /Para two\./); assert.match(t, /bug/); assert.match(t, /#5/); assert.match(t, /In Dev/);
  pushCommand("escape"); await cx.settle(); assert.equal(v.screen, "list"); assert.equal(v.shownRows()[v.at].story.id, 2);
});
test("t changes the state through the menu", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) } });
  v.input.emit("submit"); await cx.settle();
  press(v, cx, "t"); assert.deepEqual(v.menu.items.map((i) => i.label), ["Backlog", "Ready", "In Dev", "In Review", "Done"]);
  assert.equal(v.menu.at, 1); // its own state, Ready, is chosen
  press(v, cx, "down"); press(v, cx, "enter"); await cx.settle();
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { workflow_state_id: 12 });
});
test("p is only offered with a priority field, and sets the custom field", async () => {
  const fields = [{ id: "f1", name: "Priority", enabled: true, values: [{ id: "v1", value: "High", enabled: true, position: 0 }, { id: "v2", value: "Low", enabled: true, position: 1 }] }];
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, priorityField: "f1" }, routes: { ...basic(), "GET /custom-fields": fields, "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", 11) } });
  v.input.emit("submit"); await cx.settle();
  assert.match(texts(v), /priority/);
  press(v, cx, "p"); press(v, cx, "down"); press(v, cx, "enter"); await cx.settle();
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { custom_fields: [{ field_id: "f1", value_id: "v2" }] });
  const plain = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11) } });
  plain.v.input.emit("submit"); await plain.cx.settle(); press(plain.v, plain.cx, "p"); assert.equal(plain.v.menu, null);
});
test("opened with props on a story, Esc goes back to the opener", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /stories/2": S(2, "Beta", 12) }, props: { screen: "story", id: 2, backTo: { mod: "projects", props: { x: 1 } } } });
  assert.equal(v.screen, "story");
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 1); assert.deepEqual(state.overlays.at(-1), { mod: "projects", kind: "dialog", width: 0.8, height: 0.8, props: { x: 1 } });
});
test("p keeps the story's other custom fields in the PUT", async () => {
  const fields = [{ id: "f1", name: "Priority", enabled: true, values: [{ id: "v1", value: "High", enabled: true, position: 0 }, { id: "v2", value: "Low", enabled: true, position: 1 }] }];
  const story = { ...S(1, "Alpha", 11), custom_fields: [{ field_id: "f9", value_id: "v9", value: "Big" }] };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, priorityField: "f1" }, routes: { ...basic(), "GET /custom-fields": fields, "GET /stories/1": story, "PUT /stories/1": () => story } });
  v.input.emit("submit"); await cx.settle();
  press(v, cx, "p"); press(v, cx, "down"); press(v, cx, "enter"); await cx.settle();
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { custom_fields: [{ field_id: "f9", value_id: "v9" }, { field_id: "f1", value_id: "v2" }] });
});
test("Esc with a menu open closes only the menu", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11) } });
  v.input.emit("submit"); await cx.settle();
  press(v, cx, "t"); assert.notEqual(v.menu, null);
  pushCommand("escape"); await cx.settle();
  assert.equal(v.menu, null); assert.equal(v.screen, "story"); assert.equal(state.closed, 0);
});
test("start: updates Shortcut, records recent, opens the configured mod launcher, closes", async () => {
  const iter = [{ id: 99, name: "It 9", status: "started", group_ids: ["g"] }];
  const routes = { ...basic(), "GET /iterations": iter, "GET /stories/1": { ...S(1, "Alpha", 11), owner_ids: ["other"], group_id: "g" }, "PUT /stories/1": (b) => ({ ...S(1, "Alpha", b.workflow_state_id), owner_ids: b.owner_ids }) };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, launcher: { kind: "mod", name: "projects" } }, routes });
  // After open: open() resets the app home, mods/ included. The launcher is looked for only when the start runs.
  mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, "");
  press(v, cx, "s"); await cx.settle();
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { workflow_state_id: 12, owner_ids: ["other", "me"], iteration_id: 99 });
  const o = state.overlays.at(-1);
  assert.equal(o.mod, "projects");
  assert.deepEqual(o.props.launch, { v: 1, branch: "jer/sc-1/alpha", checkout: "new", name: "sc-1 · Alpha", prompt: "Read the shortcut story sc-1 for context, then suggest how to proceed.", source: { kind: "shortcut", id: "sc-1", url: "https://app.shortcut.com/w/story/1", title: "Alpha" }, repo: { names: [], urls: [], folder: null } });
  assert.deepEqual(o.props.backTo, { mod: "shortcut", props: { screen: "story", id: 1 } });
  assert.equal(JSON.parse(readFileSync(dataPath(), "utf8")).recent[0].id, 1);
  assert.equal(state.closed, 1);
});
test("start: a workflow without a start state asks, persists, and continues", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) }, space: { id: "s", folder: makeRepo(), tabs: [] } });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.screen, "pickState"); assert.match(texts(v), /Eng workflow, which has no start state yet/);
  assert.deepEqual(v.menu.items.map((i) => i.label), ["Backlog", "Ready", "In Dev", "In Review"]);
  press(v, cx, "down"); press(v, cx, "down"); press(v, cx, "enter"); await cx.settle();
  assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).startStates, { 1: 12 });
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { workflow_state_id: 12 });
  assert.equal(state.overlays.at(-1).mod, "worktree");
});
test("a stale start state opens pickState and is dropped", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 999 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11) } });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.screen, "pickState");
  pushCommand("escape"); await cx.settle();
  assert.equal(v.screen, "list"); assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).startStates, {});
});
test("start: done is refused; a Shortcut error stops before the launcher", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 14) } });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.err, "sc-1 is done. Follow-up work belongs in a new story."); assert.equal(state.overlays.length, 0);
  const bad = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": { status: 422, body: { message: "Nope" } } } });
  press(bad.v, bad.cx, "s"); await bad.cx.settle();
  assert.equal(bad.v.err, "Nope"); assert.equal(state.overlays.length, 0);
});
test("start: several open PR branches ask which, and reuse it as existing", async () => {
  const prs = [{ branch_name: "a", merged: false, closed: false, url: "https://github.com/o/api/pull/1" }, { branch_name: "b", merged: false, closed: false, url: "https://github.com/o/api/pull/2" }];
  const repo = makeRepo(); sh(repo, "branch", "b");
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/2": { ...S(2, "Beta", 12), pull_requests: prs } }, space: { id: "s", folder: repo, tabs: [] } });
  v.at = v.shownRows().findIndex((r) => r.story?.id === 2); press(v, cx, "s"); await cx.settle();
  assert.equal(v.menu.kind, "branch"); press(v, cx, "down"); press(v, cx, "enter"); await cx.settle();
  assert.deepEqual(state.overlays.at(-1).props, { folder: repo, machine: null, branch: "b", space: "s" });
});
test("start: an invalid branch from the template is refused before any launcher", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, branchTemplate: "{mention}/..{slug}" }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) } });
  press(v, cx, "s"); await cx.settle();
  assert.match(v.err, /is not a valid branch name/); assert.equal(state.overlays.length, 0);
});
test("start: Esc on the branch menu cancels with nothing written and no launcher", async () => {
  const prs = [{ branch_name: "a", merged: false, closed: false }, { branch_name: "b", merged: false, closed: false }];
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": { ...S(1, "Alpha", 11), pull_requests: prs }, "PUT /stories/1": (b) => ({ ...S(1, "Alpha", b.workflow_state_id), pull_requests: prs }) } });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.menu.kind, "branch");
  const puts = fetch.calls.filter((c) => c.method === "PUT").length;
  pushCommand("escape"); await cx.settle();
  assert.equal(v.menu, null); assert.equal(v.flash, "Start cancelled"); assert.equal(v.busy, "");
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, puts); assert.equal(state.overlays.length, 0); assert.equal(state.closed, 0);
  assert.equal(JSON.parse(readFileSync(dataPath(), "utf8")).recent, undefined);
});
