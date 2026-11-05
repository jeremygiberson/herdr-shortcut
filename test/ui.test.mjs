import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { open, texts } from "./helpers/view.mjs";
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
  await writeCache({ lists: { mine: { at: 0, data: [S(5, "Cached", 11)] } } });
  const { v } = await open({ cfg: { auth: { token: "bad" } }, routes: { ...basic(), "GET /member": { status: 401, body: { message: "Unauthorized" } } } });
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
