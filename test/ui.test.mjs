import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { open, press, texts } from "./helpers/view.mjs";
import { state, reset, pushCommand } from "./helpers/herdr-stub.mjs";
import { WF, S, basic } from "./helpers/fixtures.mjs";
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
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
test("the cache is drawn before the shell's token lookup answers", async () => {
  await writeCache({ member: { at: Date.now(), data: { id: "me", mention_name: "jer" } }, workflows: { at: Date.now(), data: [WF] }, lists: { mine: { at: 0, data: [S(5, "Cached", 11)] } } });
  let answer;
  const shell = new Promise((r) => (answer = r));
  const execGate = (command, args) => (command === "sh" && String(args.at(-1)).includes("SC_SLOW_TOKEN") ? shell : null);
  const { v, cx, fetch } = await open({ cfg: { auth: { env: "SC_SLOW_TOKEN" } }, routes: basic(), settle: false, execGate });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(v.client, null); assert.equal(fetch.calls.length, 0);
  assert.match(texts(v), /Cached/);
  answer({ code: 0, stdout: "motd<<shortcut-token>>T<<shortcut-token>>", stderr: "" });
  await cx.settle();
  assert.equal(fetch.calls.find((c) => c.path === "/stories/search").headers["Shortcut-Token"], "T");
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
test("a tab switched while the first refresh runs is loaded once it ends", async () => {
  const routes = { ...basic(), "GET /groups": [{ id: "g1", name: "Eng", member_ids: ["me"], archived: false }] };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes, settle: false });
  assert.equal(v.refreshing, true);
  press(v, cx, "2"); await cx.settle();
  assert.equal(v.tab, "team"); assert.equal(v.refreshing, false);
  assert.deepEqual(fetch.calls.filter((c) => c.path === "/stories/search").at(-1).body, { group_ids: ["g1"], workflow_state_types: ["started"], archived: false });
  assert.doesNotMatch(texts(v), /Loading/);
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
// A selected space in a git repo: the shipped launcher's preflight passes.
const ready = () => ({ id: "s", folder: makeRepo(), tabs: [] });
const installProjects = () => { mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, ""); };
test("start: updates Shortcut, records recent, opens the configured mod launcher, closes", async () => {
  const iter = [{ id: 99, name: "It 9", status: "started", group_ids: ["g"] }];
  const routes = { ...basic(), "GET /iterations": iter, "GET /stories/1": { ...S(1, "Alpha", 11), owner_ids: ["other"], group_id: "g" }, "PUT /stories/1": (b) => ({ ...S(1, "Alpha", b.workflow_state_id), owner_ids: b.owner_ids }) };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, launcher: { kind: "mod", name: "projects" } }, routes });
  // After open: open() resets the app home, mods/ included. The launcher is looked for only when the start runs.
  installProjects();
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
  // Unstarted and started states only, the first started one highlighted.
  assert.deepEqual(v.menu.items.map((i) => i.label), ["Ready", "In Dev", "In Review"]);
  assert.equal(v.menu.at, v.menu.items.findIndex((i) => i.label === "In Dev"));
  press(v, cx, "down"); press(v, cx, "up"); press(v, cx, "enter"); await cx.settle();
  assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).startStates, { 1: 12 });
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { workflow_state_id: 12 });
  assert.equal(state.overlays.at(-1).mod, "worktree");
});
test("start: pickState resumes from a fresh copy of the story", async () => {
  // Someone starts the story while pickState is open: the second GET answers it already In Review.
  let gets = 0;
  const routes = { ...basic(), "GET /stories/1": () => (++gets === 1 ? S(1, "Alpha", 11) : { ...S(1, "Alpha", 13), owner_ids: ["other"] }), "PUT /stories/1": (b) => ({ ...S(1, "Alpha", 13), ...b }) };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, iteration: "never" }, routes, space: ready() });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.screen, "pickState");
  press(v, cx, "enter"); await cx.settle();
  assert.equal(gets, 2);
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { owner_ids: ["other", "me"] });
});
test("a stale start state opens pickState and is dropped", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 999 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11) }, space: ready() });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.screen, "pickState");
  pushCommand("escape"); await cx.settle();
  assert.equal(v.screen, "list"); assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).startStates, {});
});
test("start: done is refused; a Shortcut error stops before the launcher", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 14) }, space: ready() });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.err, "sc-1 is done. Follow-up work belongs in a new story."); assert.equal(state.overlays.length, 0);
  const bad = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": { status: 422, body: { message: "Nope" } } }, space: ready() });
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
test("start: an invalid branch from the template is refused before the ticket is touched", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, branchTemplate: "{mention}/..{slug}" }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) }, space: ready() });
  press(v, cx, "s"); await cx.settle();
  assert.match(v.err, /^"jer\/\.\.alpha" is not a valid branch name: check the branch template in settings$/); assert.equal(state.overlays.length, 0);
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, 0);
});
test("start: Esc on the branch menu cancels with nothing written and no launcher", async () => {
  const prs = [{ branch_name: "a", merged: false, closed: false }, { branch_name: "b", merged: false, closed: false }];
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": { ...S(1, "Alpha", 11), pull_requests: prs }, "PUT /stories/1": (b) => ({ ...S(1, "Alpha", b.workflow_state_id), pull_requests: prs }) }, space: ready() });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.menu.kind, "branch");
  const puts = fetch.calls.filter((c) => c.method === "PUT").length;
  pushCommand("escape"); await cx.settle();
  // The update is already in Shortcut (s again resumes): the message says so.
  assert.equal(v.menu, null); assert.match(v.err, /^sc-1 was updated in Shortcut; Start cancelled$/); assert.equal(v.busy, "");
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, puts); assert.equal(state.overlays.length, 0); assert.equal(state.closed, 0);
  assert.equal(JSON.parse(readFileSync(dataPath(), "utf8")).recent, undefined);
});
test("start: a launcher error after the update says the ticket was updated", async () => {
  const main = () => `${state.appHome}/mods/projects/main.js`;
  // The mod is there when readiness checks it, and gone by the hand-off.
  const routes = { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => { rmSync(main()); return S(1, "Alpha", b.workflow_state_id); } };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, launcher: { kind: "mod", name: "projects" } }, routes });
  installProjects();
  press(v, cx, "s"); await cx.settle();
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, 1);
  assert.equal(v.err, 'sc-1 was updated in Shortcut; launcher "projects" is not installed'); assert.equal(state.overlays.length, 0); assert.equal(state.closed, 0);
});
test("start: a recent that cannot be saved does not stop the launch", async () => {
  // Another writer changes the settings file while the start runs: the compare-and-write of recent fails.
  const routes = { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => { writeFileSync(dataPath(), "{}\n"); return S(1, "Alpha", b.workflow_state_id); } };
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, iteration: "never", launcher: { kind: "mod", name: "projects" } }, routes });
  installProjects();
  press(v, cx, "s"); await cx.settle();
  assert.equal(state.overlays.at(-1).mod, "projects"); assert.equal(v.err, "");
  assert.match(v.flash, /recent not saved/);
  cx.fire(1500); assert.equal(state.closed, 1);
});
test("start: the notes are shown for 1.5 s before the popup closes", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, iteration: "never", launcher: { kind: "mod", name: "projects" } }, routes: { ...basic(), "GET /stories/2": S(2, "Beta", 12) } });
  installProjects();
  v.at = v.shownRows().findIndex((r) => r.story?.id === 2); press(v, cx, "s"); await cx.settle();
  assert.equal(state.overlays.at(-1).mod, "projects");
  assert.match(v.flash, /state kept: In Dev/); assert.equal(state.closed, 0);
  cx.fire(1500); assert.equal(state.closed, 1);
});
test("start: a mod launcher that is not installed refuses before the ticket is touched", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, launcher: { kind: "mod", name: "projects" } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) } });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.err, 'launcher "projects" is not installed'); assert.equal(v.busy, "");
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, 0); assert.equal(state.overlays.length, 0);
  assert.equal(JSON.parse(readFileSync(dataPath(), "utf8")).recent, undefined);
});
test("start: the shipped launcher with no selected space refuses before the ticket is touched", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) } });
  press(v, cx, "s"); await cx.settle();
  assert.equal(v.err, "Select a space in the repo first, or choose a launcher mod in settings");
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, 0); assert.equal(state.overlays.length, 0);
});
test("start: a second s while one is on its way is ignored", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 } }, routes: { ...basic(), "GET /stories/1": S(1, "Alpha", 11), "PUT /stories/1": (b) => S(1, "Alpha", b.workflow_state_id) }, space: ready() });
  press(v, cx, "s"); press(v, cx, "s"); await cx.settle();
  assert.equal(fetch.calls.filter((c) => c.method === "GET" && c.path === "/stories/1").length, 1);
});
test("start: a workflow with no state but done is refused instead of an empty pickState", async () => {
  const wf = { id: 2, name: "Ops", states: [{ id: 20, name: "Done", type: "done" }, { id: 21, name: "Open", type: "unstarted" }] };
  const story = { ...S(3, "Gamma", 21), workflow_id: 2 };
  const onlyDone = { ...wf, states: [wf.states[0]] };
  // The story's own state is not in the workflow (as after a workflow edit): not done, so not refused as done.
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /workflows": [WF, onlyDone], "GET /stories/3": story }, space: ready() });
  v.input.set_value("sc-3"); await cx.settle();
  press(v, cx, "s"); await cx.settle();
  assert.notEqual(v.screen, "pickState"); assert.equal(v.menu, null);
  assert.equal(v.err, "Ops has no state to start in");
});

test("n opens the form with defaults, ctrl+Enter creates and opens the story", async () => {
  const routes = { ...basic(), "GET /groups": [{ id: "g1", name: "Eng", member_ids: ["me"], archived: false, workflow_ids: [1] }], "POST /stories": (b) => ({ ...S(77, b.name, b.workflow_state_id), ...b }) };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes });
  press(v, cx, "n"); assert.equal(v.screen, "create");
  v.title.set_value("New thing"); v.desc.set_value("Body");
  press(v, cx, "enter", { control: true }); await cx.settle();
  assert.deepEqual(fetch.calls.find((c) => c.method === "POST" && c.path === "/stories").body, { name: "New thing", description: "Body", group_id: "g1", workflow_state_id: 11, story_type: "feature", owner_ids: ["me"] });
  assert.equal(v.screen, "story"); assert.equal(v.cur.id, 77); assert.match(texts(v), /Press s to start it/);
});
test("an empty name does not submit", async () => {
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  press(v, cx, "n"); press(v, cx, "enter", { control: true }); await cx.settle();
  assert.equal(fetch.calls.some((c) => c.method === "POST" && c.path === "/stories"), false); assert.match(v.err, /name/i);
});

test("settings: token masked, env name editable, Test shows the member", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "abcdef1234" } }, routes: basic() });
  press(v, cx, ","); assert.equal(v.screen, "settings");
  assert.match(texts(v), /••••1234/); assert.doesNotMatch(texts(v), /abcdef1234/);
  v.testToken(cx); await cx.settle(); assert.match(v.flash, /Jer/);
});
test("settings: start states per workflow with the placeholder, saved on change", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  press(v, cx, ","); assert.match(texts(v), /Eng[\s\S]*Please select a start state/);
  v.openStateMenu(1, cx); assert.deepEqual(v.menu.items.map((i) => i.label), ["Please select a start state", "Ready", "In Dev", "In Review"]);
  press(v, cx, "down"); press(v, cx, "down"); press(v, cx, "enter"); cx.fire(300); await cx.settle();
  assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).startStates, { 1: 12 });
});
test("settings: the launcher menu lists installed mods and the shipped dialog", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  // After open: open() resets the app home, mods/ included.
  mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, "");
  mkdirSync(`${state.appHome}/mods/empty`, { recursive: true });
  press(v, cx, ","); v.openLauncherMenu(cx); await cx.settle();
  assert.deepEqual(v.menu.items.map((i) => i.label), ["Shipped worktree dialog", "Mod: projects"]);
  press(v, cx, "down"); press(v, cx, "enter"); cx.fire(300); await cx.settle();
  assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).launcher, { kind: "mod", name: "projects" });
});
test("settings: branch template preview and priority field", async () => {
  const fields = [{ id: "f1", name: "Priority", enabled: true, values: [{ id: "v1", value: "High", enabled: true }] }, { id: "f2", name: "Empty", enabled: true, values: [] }];
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: { ...basic(), "GET /custom-fields": fields } });
  press(v, cx, ","); assert.match(texts(v), /jer\/sc-1234\/sample-story/);
  v.openPriorityMenu(cx); assert.deepEqual(v.menu.items.map((i) => i.label), ["None", "Priority"]);
});
test("settings: a pasted token is saved with mode 600, then masked, and never shown or said", async () => {
  const { v, cx } = await open({ cfg: { auth: { env: "SC_UNSET_X" } }, routes: basic() });
  assert.equal(v.screen, "signIn");
  press(v, cx, ","); assert.equal(v.screen, "settings");
  v.tokenInput.set_value("newtok9999"); v.tokenInput.emit("change"); cx.fire(300); await cx.settle();
  assert.equal(JSON.parse(readFileSync(dataPath(), "utf8")).auth.token, "newtok9999");
  assert.equal(statSync(dataPath()).mode & 0o777, 0o600);
  assert.match(texts(v), /••••9999/);
  for (const s of [texts(v), v.flash, v.err]) assert.doesNotMatch(s, /newtok9999/);
});
test("settings: a token typed in the env name box is neither saved nor shown", async () => {
  const { v, cx } = await open({ cfg: { auth: { env: "SC_UNSET_X" } }, routes: basic() });
  press(v, cx, ",");
  v.envInput.set_value("abc-def1234"); v.envInput.emit("change"); cx.fire(300); await cx.settle();
  assert.doesNotMatch(readFileSync(dataPath(), "utf8"), /abc-def1234/);
  assert.match(v.err, /environment variable name/);
  v.testToken(cx); await cx.settle();
  pushCommand("escape"); await cx.settle();
  for (const s of [texts(v), v.flash, v.err, v.signInNote]) assert.doesNotMatch(s, /abc-def1234/);
});
test("settings: a short token is masked without a suffix", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  press(v, cx, ","); assert.match(texts(v), /••••/); assert.doesNotMatch(texts(v), /••••T/);
});

// The popup is as tall as its content, so a scroll region without a height of its own collapses to nothing: the
// settings screen drew only its footer (2026-11-05). Like the list and the story body, it takes an explicit height.
const byId = (el, id) => { if (el?.op?.("id")?.[0] === id) return el; for (const k of el?.kids ?? []) { const f = byId(k, id); if (f) return f; } return null; };
test("settings: the scroll region has a height of its own, not flex_1", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "abcdef1234" } }, routes: basic() });
  press(v, cx, ","); assert.equal(v.screen, "settings");
  const el = byId(v.render(), "settings");
  assert.ok(el, "settings element drawn");
  assert.equal(typeof el.op("h")?.[0], "number"); assert.ok(el.has("flex_shrink")); assert.ok(!el.has("flex_1"));
});
