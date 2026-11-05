import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { open, press, texts } from "./helpers/view.mjs";
import { state, reset, pushCommand } from "./helpers/herdr-stub.mjs";
import { WF, S, basic } from "./helpers/fixtures.mjs";
const { readCache, writeCache } = await import("../mods/shortcut/api.js");

beforeEach(reset);
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
