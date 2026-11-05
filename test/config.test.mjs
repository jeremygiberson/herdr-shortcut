import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, statSync } from "node:fs";
import { reset } from "./helpers/herdr-stub.mjs";
const { normalize, load, save, dataPath, resolveToken, slug, storyVars, expand } = await import("../mods/shortcut/config.js");

beforeEach(() => reset());

test("normalize fills defaults and drops unknown keys", () => {
  const c = normalize({ bogus: 1, startStates: { "5": "7" }, launcher: { kind: "mod", name: "projects" } });
  assert.equal(c.bogus, undefined);
  assert.deepEqual(c.auth, { env: "SHORTCUT_API_TOKEN" });
  assert.equal(c.startPrompt, "Read the shortcut story {id} for context, then suggest how to proceed.");
  assert.equal(c.branchTemplate, "{mention}/sc-{number}/{slug}");
  assert.deepEqual(c.startStates, { 5: 7 });
  assert.deepEqual(c.launcher, { kind: "mod", name: "projects" });
  assert.deepEqual(normalize({ launcher: { kind: "weird" } }).launcher, { kind: "shipped" });
});
test("normalize edge cases", () => {
  assert.deepEqual(normalize({ auth: { token: "  ", env: "X_Y" } }).auth, { env: "X_Y" });
  assert.deepEqual(normalize({ auth: { token: "t", env: "X" } }).auth, { token: "t" });
  assert.deepEqual(normalize({ startStates: { a: "x", b: 1.5, c: 3 } }).startStates, { c: 3 });
  assert.equal(normalize({ iteration: "bogus" }).iteration, "current-if-unset");
  assert.equal(normalize({ iteration: "never" }).iteration, "never");
  assert.equal(normalize({ priorityField: "" }).priorityField, null);
  const recent = Array.from({ length: 40 }, (_, i) => ({ id: i }));
  assert.equal(normalize({ recent: [...recent, { id: "x" }] }).recent.length, 30);
  assert.deepEqual(normalize({ launcher: { kind: "mod" } }).launcher, { kind: "shipped" });
  assert.equal(normalize(null).startPrompt.length > 0, true);
});
test("load tolerates a missing or broken file", async () => {
  assert.equal((await load()).error, null);
  writeFileSync(dataPath(), "{nope");
  const r = await load(); assert.match(r.error, /^data\/shortcut\.json is not valid JSON:/); assert.equal(r.cfg.iteration, "current-if-unset");
});
test("save writes the file and chmods it when a token is kept", async () => {
  const raw = await save(normalize({ auth: { token: "abc" } }), null);
  assert.equal((statSync(dataPath()).mode & 0o777), 0o600);
  assert.match(raw, /"token": "abc"/);
  assert.equal((await load()).raw, raw);
});
test("resolveToken trims, prefers the pasted token, validates the env name", async () => {
  assert.deepEqual(await resolveToken(normalize({ auth: { token: " tok \n" } })), { token: "tok", error: null });
  process.env.SC_TEST_TOKEN = "fromenv\n";
  assert.deepEqual(await resolveToken(normalize({ auth: { env: "SC_TEST_TOKEN" } })), { token: "fromenv", error: null });
  assert.deepEqual(await resolveToken(normalize({ auth: { env: "SC_UNSET_X" } })), { token: "", error: null });
  assert.match((await resolveToken(normalize({ auth: { env: "bad name; rm" } }))).error, /Not an environment variable name/);
});
test("slug and templates", () => {
  assert.equal(slug("Fix the Thing!! (v2)"), "fix-the-thing-v2");
  assert.equal(slug("🎉"), "story");
  assert.equal(slug("a".repeat(60)).length, 48);
  assert.equal(slug("a".repeat(47) + " b"), "a".repeat(47));
  const vars = storyVars({ id: 12, name: "Fix it", app_url: "https://x/story/12" }, { mention_name: "jer" }, "jer/sc-12/fix-it");
  assert.equal(expand("{mention}/sc-{id}/{slug} {number} {url} {branch} {nope}", vars), "jer/sc-sc-12/fix-it 12 https://x/story/12 jer/sc-12/fix-it {nope}");
});
