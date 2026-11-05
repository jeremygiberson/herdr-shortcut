import "./helpers/setup.mjs";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { reset } from "./helpers/herdr-stub.mjs";
import { fakeApi } from "./helpers/fetch.mjs";
const { ApiError, createClient, cachePath, readCache, writeCache, fresh } = await import("../mods/shortcut/api.js");

beforeEach(() => reset());

test("every call carries the token header and parses JSON", async () => {
  const f = fakeApi({ "GET /member": { id: "m1", mention_name: "jer" } });
  const c = createClient({ token: "T", fetch: f });
  assert.deepEqual(await c.me(), { id: "m1", mention_name: "jer" });
  assert.equal(f.calls[0].headers["Shortcut-Token"], "T");
  assert.equal(f.calls[0].body, undefined);
});
test("errors carry Shortcut's message and the status", async () => {
  const c = createClient({ token: "T", fetch: fakeApi({ "GET /stories/9": { status: 404, body: { message: "Resource not found." } } }) });
  await assert.rejects(c.story(9), (e) => e instanceof ApiError && e.status === 404 && e.message === "Resource not found.");
});
test("429 waits once for Retry-After, then gives up", async () => {
  let n = 0; const waits = [];
  const f = fakeApi({ "GET /member": () => (++n < 2 ? { status: 429, headers: { "retry-after": "3" }, body: {} } : { id: "m" }) });
  assert.deepEqual(await createClient({ token: "T", fetch: f, wait: (s) => waits.push(s) }).me(), { id: "m" });
  assert.deepEqual(waits, [3]);
  const always = fakeApi({ "GET /member": { status: 429, body: {} } });
  await assert.rejects(createClient({ token: "T", fetch: always, wait: () => {} }).me(), /429/);
});
test("searchStories follows next up to the page limit and says when it cut", async () => {
  const pages = { "": { data: [1], next: "/api/v3/stories/search?next=a" }, a: { data: [2], next: "/api/v3/stories/search?next=b" }, b: { data: [3], next: null } };
  const f = fakeApi({ "POST /stories/search": (body, url) => pages[new URL(url).searchParams.get("next") ?? ""] });
  const c = createClient({ token: "T", fetch: f });
  assert.deepEqual(await c.searchStories({ owner_ids: ["m"] }, { pages: 2 }), { data: [1, 2], cut: true });
  assert.deepEqual(await c.searchStories({ owner_ids: ["m"] }), { data: [1, 2, 3], cut: false });
});
test("the cache file round-trips and tolerates garbage", async () => {
  assert.deepEqual(await readCache(), {});
  await writeCache({ member: { at: 5, data: { id: "m" } } });
  assert.deepEqual((await readCache()).member.data, { id: "m" });
  writeFileSync(cachePath(), "nope"); assert.deepEqual(await readCache(), {});
  assert.equal(fresh({ at: 1000, data: 1 }, 500, 1400), true); assert.equal(fresh({ at: 1000 }, 500, 1600), false); assert.equal(fresh(undefined, 500), false);
});
test("list helpers filter, 429 message wins over body, and writes send bodies", async () => {
  const f = fakeApi({
    "GET /groups": [{ archived: false, id: 1 }, { archived: true, id: 2 }],
    "GET /epics": [{ archived: false, completed: false, id: 1 }, { archived: false, completed: true, id: 2 }],
    "GET /custom-fields": [{ enabled: true }, { enabled: false }],
    "GET /search/stories": { data: [7] },
    "PUT /stories/5": (b) => b,
    "POST /stories": (b) => b,
    "GET /member": { status: 429, body: { message: "slow down" } },
  });
  const c = createClient({ token: "SECRET-TOKEN", fetch: f, wait: () => {} });
  assert.deepEqual(await c.groups(), [{ archived: false, id: 1 }]);
  assert.deepEqual((await c.epics()).map((e) => e.id), [1]);
  assert.equal((await c.customFields()).length, 1);
  assert.deepEqual(await c.textSearch("a b"), [7]);
  assert.equal(f.calls.at(-1).path, "/search/stories");
  assert.deepEqual(await c.updateStory(5, { name: "x" }), { name: "x" });
  assert.deepEqual(await c.createStory({ name: "y" }), { name: "y" });
  await assert.rejects(c.me(), (e) => /429/.test(e.message) && !e.message.includes("SECRET"));
});
