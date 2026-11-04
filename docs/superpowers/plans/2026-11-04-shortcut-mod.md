# Shortcut Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Herdr popup that lists, shows, creates and starts Shortcut stories, and hands "work on branch X with this prompt" to a configurable launcher (the shipped worktree dialog or a mod implementing the launch contract).

**Architecture:** One `View` in `main.js` over four pure-ish modules: `config.js` (settings file, token, templates), `api.js` (Shortcut v3 client and cache), `start.js` (what Start changes on Shortcut and which branch it uses), `launch.js` (the launch request and the launcher handoff). The view renders from cache first and refreshes in the background, as herdr-linear does. Tests run under plain Node with stubs for `herdr` and gpui, copied from herdr-projects.

**Tech Stack:** JavaScript ES modules on gpui-kit / gpui-base inside herdr-app 0.1.13 with hc 0.1.18; `fetch` (built-in to mods); `node --test test/*.test.mjs`; `herdr-app check mods/shortcut`; git.

**Spec:** `docs/superpowers/specs/2026-11-04-shortcut-mod-design.md`. The projects mod's launch entry (spec 8.3) is built first from `~/gitprojects/herdr-projects/docs/superpowers/plans/2026-11-04-launch-by-props.md`; Task 11 of this plan needs it installed.

## Global Constraints

- Shortcut REST v3 only: base `https://api.app.shortcut.com/api/v3`, header `Shortcut-Token`, 200 requests/minute, never more than one retry on 429.
- The token is never logged, never written to the cache file, never shown in full after it is saved; `data/shortcut.json` is `chmod 600` whenever it holds a token.
- Start never removes an owner, never moves a story backwards (state changes only from `backlog`/`unstarted` states), refuses `done` stories, and sets an iteration only when exactly one started iteration fits.
- The mod passes nothing about agents, worktree roots, base branches or setup to a launcher. The shipped path passes `{ folder, machine: null, branch, space }` only.
- Launch contract v1 exactly as spec section 7; `backTo` is `{ mod: "shortcut", props: { screen: "story", id } }`.
- Defaults (spec section 5): env var `SHORTCUT_API_TOKEN`; prompt `Read the shortcut story {id} for context, then suggest how to proceed.`; branch `{mention}/sc-{id}/{slug}`; iteration `current-if-unset`; launcher `{ kind: "shipped" }`; recent keeps 30.
- No `setTimeout`; `cx` is kept only as `this.cx` set once in `init` (herdr-projects' pattern); `herdr-app check mods/shortcut` after every task that touches `mods/`; one commit per task on `main` (new repo, no branch needed).
- Visuals follow herdr-linear's `look.js` and icon set under its MIT license, attribution in `LICENSE-herdr-linear`.

## Review Focus

- A pasted token with surrounding whitespace or a trailing newline: trimmed before use and before saving (Task 2 test `resolveToken trims`).
- A story whose configured start state id is no longer in its workflow: treated as unconfigured, the stale entry dropped on save, pickState shown (Task 4 test `startDecision: stale state id asks again`, Task 8 test `a stale start state opens pickState`).
- A story with no team and two started iterations: iteration left alone with the note `iteration not set: 2 started iterations, none chosen` (Task 4 test `currentIteration: ambiguous`).
- A story name that slugs to nothing (emoji only): the slug falls back to `story` so the branch stays a valid ref (Task 2 test `slug falls back`).
- A 401 mid-session: the cached member is cleared, the sign-in screen shows, list caches are kept so the next successful open is instant (Task 6 test `401 shows sign-in and keeps the list cache`).

---

### Task 1: Scaffold, look, test harness

**Files:**
- Create: `mods/shortcut/mod.json`, `mods/shortcut/main.js` (a View that renders the word "Shortcut"), `mods/shortcut/look.js`, `mods/shortcut/icons/*.svg`, `LICENSE-herdr-linear`, `keys.json`, `README.md` (title and one paragraph), `.gitignore` (`node_modules`)
- Create: `test/helpers/gpui-stub.mjs`, `test/helpers/hooks.mjs`, `test/helpers/setup.mjs` (copied from `~/gitprojects/herdr-projects/test/helpers/`, log prefix `[shortcut]`), `test/helpers/herdr-stub.mjs` (new, below), `test/helpers/fetch.mjs` (new, below), `test/helpers/view.mjs` (new, below)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces `test/helpers/herdr-stub.mjs`: `state` (`{ home, appHome, spaces, panes, props, runs, overlays, closed, commands, known }`), `reset()`, and the `herdr` exports `appHome, home, spaces, panes, props, run, exec (real child_process), openOverlay (push to state.overlays), closeOverlay (state.closed++), theme (the object herdr-projects' stub returns), readTextFile, writeTextFile, knownAgents, nextCommand (resolves the next item pushed to state.commands via pushCommand(c)), shared, setShared`. `setup.mjs` also installs `globalThis.localStorage` (Map-backed `getItem/setItem/removeItem`).
- Produces `test/helpers/fetch.mjs`: `fakeApi(routes) → fetch`, where `routes` maps `"GET /member"`, `"POST /stories/search"`, … to a value or `(body, url) => value | { status, body }`; `fetch.calls` records `{ method, path, headers, body }`.
- Produces `test/helpers/view.mjs`: `open({ cfg = {}, routes = {}, props = {} }) → { v, cx, fetch }`: writes `data/shortcut.json` from `cfg` (merged over nothing, so tests state what they need), sets `globalThis.fetch = fakeApi(routes)`, inits the view with the fake `cx` from herdr-projects' `ui.test.mjs` plus `open_url(url)` and `write_to_clipboard(text)` recorders, settles. Also `press(v, cx, key, mods)`, `texts(v)`.
- Produces `look.js`: herdr-linear's exports minus Linear specifics: `MONO, tint, tones, icon, chip, words, cap, key, countPill, ago`, plus `stateIcon(type)` → `"sc-backlog" | "sc-todo" | "sc-prog" | "sc-done"` (the `lin-*` SVGs renamed) and `stateColor(o, type)` → backlog `o.dim`, unstarted `o.accent`, started `o.work`, done `o.review`.

- [ ] **Step 1: Write the failing smoke test**

```js
// test/ui.test.mjs
import "./helpers/setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { open, texts } from "./helpers/view.mjs";
test("the popup renders its title", async () => {
  const { v } = await open({ routes: { "GET /member": { status: 401, body: { message: "Unauthorized" } } } });
  assert.match(texts(v), /Shortcut/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/*.test.mjs`
Expected: FAIL, cannot find `../mods/shortcut/main.js`.

- [ ] **Step 3: Create the files**

`mod.json` exactly as spec section 3. `keys.json` exactly as spec section 9. `main.js`: `export default class Shortcut extends View { init(_p, cx) { this.cx = cx; } render() { return v_flex().id("shortcut").p(16).bg(theme().popover).child(div().child("Shortcut")); } }`. Copy icons and `look.js`, rename the `lin-*` icons to `sc-*`, delete `projectIcon`, `PRIORITIES`, `priorityIcon`, `hue`.

- [ ] **Step 4: Run to verify it passes, and check the mod**

Run: `node --test test/*.test.mjs && herdr-app check mods/shortcut`
Expected: PASS; check reports no error.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Scaffold the shortcut mod with herdr-linear's look and a test harness"
```

---

### Task 2: Settings file, token, templates (`config.js`)

**Files:**
- Create: `mods/shortcut/config.js`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULTS` (spec section 5 values; `startStates: {}`, `priorityField: null`, `recent: []`).
  - `dataPath() → string` (`${appHome()}/data/shortcut.json`).
  - `normalize(raw) → cfg`: fills every default, drops unknown keys, `auth` is `{ env }` or `{ token }` (token wins when both), `startStates` values coerced to integers, `iteration` ∈ `"current-if-unset" | "never"`, `launcher` ∈ `{ kind: "shipped" } | { kind: "mod", name }` (bad → default), `recent` sliced to 30.
  - `load() → Promise<{ cfg, raw, error: string|null }>` (missing file → defaults; bad JSON → defaults and `error`).
  - `save(cfg, raw) → Promise<string>`: `writeTextFile(dataPath(), text, raw)`, then `exec("chmod", ["600", path])` when `cfg.auth.token`; returns the text written (the next `raw`).
  - `resolveToken(cfg) → Promise<{ token: string, error: string|null }>`: pasted token trimmed; else env name validated by `/^[A-Za-z_][A-Za-z0-9_]*$/` (bad → `error: 'Not an environment variable name: "…"'`), read with `exec("sh", ["-lc", 'printf %s "$' + name + '"'])`, trimmed; empty → `token: ""`.
  - `slug(text) → string` (lowercase, `[^a-z0-9]+` → `-`, trimmed of `-`, max 48, empty → `"story"`).
  - `storyVars(story, me, branch = "") → { id: "sc-<id>", number: "<id>", slug, title, url, mention, branch }`.
  - `expand(template, vars) → string` (unknown `{x}` kept as typed).

- [ ] **Step 1: Write the failing tests**

```js
// test/config.test.mjs
test("normalize fills defaults and drops unknown keys", () => {
  const c = normalize({ bogus: 1, startStates: { "5": "7" }, launcher: { kind: "mod", name: "projects" } });
  assert.equal(c.bogus, undefined);
  assert.deepEqual(c.auth, { env: "SHORTCUT_API_TOKEN" });
  assert.equal(c.startPrompt, "Read the shortcut story {id} for context, then suggest how to proceed.");
  assert.equal(c.branchTemplate, "{mention}/sc-{id}/{slug}");
  assert.deepEqual(c.startStates, { 5: 7 });
  assert.deepEqual(c.launcher, { kind: "mod", name: "projects" });
  assert.deepEqual(normalize({ launcher: { kind: "weird" } }).launcher, { kind: "shipped" });
});
test("load tolerates a missing or broken file", async () => {
  assert.equal((await load()).error, null);
  writeFileSync(dataPath(), "{nope");
  const r = await load(); assert.match(r.error, /not valid JSON/); assert.equal(r.cfg.iteration, "current-if-unset");
});
test("save writes the file and chmods it when a token is kept", async () => {
  const raw = await save(normalize({ auth: { token: "abc" } }), null);
  assert.equal((statSync(dataPath()).mode & 0o777), 0o600);
  assert.match(raw, /"token": "abc"/);
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
  const vars = storyVars({ id: 12, name: "Fix it", app_url: "https://x/story/12" }, { mention_name: "jer" }, "jer/sc-12/fix-it");
  assert.equal(expand("{mention}/sc-{id}/{slug} {number} {url} {branch} {nope}", vars), "jer/sc-sc-12/fix-it 12 https://x/story/12 jer/sc-12/fix-it {nope}");
});
```
(Note the last assertion: `{id}` expands to `sc-12`, so the default branch template is `{mention}/sc-{number}/{slug}` — **correction to the spec's default**: use `{mention}/sc-{number}/{slug}` as `DEFAULTS.branchTemplate` and in the settings hint; `{id}` stays `sc-12` for prompts. Update spec section 5 and 13 in the same commit.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `config.js`**

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mods/shortcut/config.js test/config.test.mjs docs/superpowers/specs/2026-11-04-shortcut-mod-design.md
git commit -m "Settings file, token resolution and templates"
```

---

### Task 3: Shortcut v3 client and cache (`api.js`)

**Files:**
- Create: `mods/shortcut/api.js`
- Test: `test/api.test.mjs`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number, retryAfter: number|null }` (message = Shortcut's `message` field, else `"Shortcut: HTTP <status>"`).
  - `createClient({ token, fetch = globalThis.fetch, wait = (s) => exec("sleep", [String(s)]) }) → client` with `me()`, `workflows()`, `groups()` (unarchived), `epics()` (`archived === false && completed === false`), `iterations()`, `customFields()` (`enabled`), `story(id)`, `searchStories(body, { pages = 4 } = {})` (follows `next` up to `pages`, returns `{ data, cut: boolean }`), `textSearch(query, pageSize = 25)` → `data`, `updateStory(id, patch)`, `createStory(params)`. Every call sends `Shortcut-Token` and `Content-Type: application/json`; `GET` has no body.
  - 429 handling: on the first 429 wait `Retry-After` seconds (default 2) once and retry; a second 429 throws.
  - `cachePath() → string`; `readCache() → Promise<object>` (`{}` when missing or broken); `writeCache(obj) → Promise<void>`; `fresh(entry, maxMs, now = Date.now()) → boolean` for `{ at, data }` entries.

- [ ] **Step 1: Write the failing tests**

```js
// test/api.test.mjs
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/api.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `api.js`**

`next` from Shortcut is a path beginning `/api/v3/…`; request it against the origin `https://api.app.shortcut.com`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/api.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mods/shortcut/api.js test/api.test.mjs
git commit -m "Shortcut v3 client with paging, 429 backoff and a cache file"
```

---

### Task 4: What Start changes, and which branch (`start.js`)

**Files:**
- Create: `mods/shortcut/start.js`
- Test: `test/start.test.mjs`

**Interfaces:**
- Consumes: `storyVars`, `expand` (Task 2).
- Produces:
  - `startDecision({ story, workflow, me, cfg, iterations }) → { refused: string|null, patch: object|null, notes: string[], askState: boolean, dropStale: boolean }` where `workflow` is the story's workflow object (`{ id, name, states }`). Rules (spec 8.1 step 4): current state type `done` → `refused: "sc-<id> is done. Follow-up work belongs in a new story."`; configured state id not in `workflow.states` → `askState: true, dropStale: true`; no configured state → `askState: true`; state set only when current type ∈ backlog/unstarted (else note `state kept: <name>`); `owner_ids` = existing + `me.id` appended only if absent; iteration per `currentIteration`. `patch` is `null` when nothing changes.
  - `currentIteration(story, iterations) → { id: number } | { reason: string }`: candidates = `status === "started"` and (`group_ids` empty or includes `story.group_id`); one → id; zero → `"no started iteration for this team"`; several → `"<n> started iterations, none chosen"`.
  - `branchCandidates(story, cfg, vars) → { level: "pr"|"story"|"template", candidates: string[], checkout: "new"|"existing" }` (spec 8.1 step 6; PR level = `pull_requests` with `merged === false && closed === false`, deduplicated; story level = `story.branches[].name` deduplicated; template level = one expanded branch).
  - `repoHints(story) → { names: string[], urls: string[], folder: null }`: from `branches[].url` and `pull_requests[].url`, repo url = everything before `/pull/` or `/tree/` (or the whole url), name = its last path segment without `.git`, both deduplicated.

- [ ] **Step 1: Write the failing tests**

```js
// test/start.test.mjs
const WF = { id: 1, name: "Eng", states: [{ id: 10, name: "Backlog", type: "backlog" }, { id: 11, name: "Ready", type: "unstarted" }, { id: 12, name: "In Dev", type: "started" }, { id: 13, name: "In Review", type: "started" }, { id: 14, name: "Done", type: "done" }] };
const cfg = (o = {}) => normalize({ startStates: { 1: 12 }, ...o });
const me = { id: "me" };
const story = (o) => ({ id: 7, name: "X", workflow_id: 1, workflow_state_id: 11, owner_ids: ["other"], group_id: "g", iteration_id: null, branches: [], pull_requests: [], ...o });
test("startDecision: unstarted → start state, me appended, iteration set", () => {
  const d = startDecision({ story: story(), workflow: WF, me, cfg: cfg(), iterations: [{ id: 99, status: "started", group_ids: ["g"] }] });
  assert.deepEqual(d, { refused: null, askState: false, dropStale: false, notes: [], patch: { workflow_state_id: 12, owner_ids: ["other", "me"], iteration_id: 99 } });
});
test("startDecision: a started story keeps its state; already an owner; nothing to patch", () => {
  const d = startDecision({ story: story({ workflow_state_id: 13, owner_ids: ["me"], iteration_id: 5 }), workflow: WF, me, cfg: cfg(), iterations: [] });
  assert.equal(d.patch, null); assert.deepEqual(d.notes, ["state kept: In Review"]);
});
test("startDecision: done is refused", () => {
  assert.equal(startDecision({ story: story({ workflow_state_id: 14 }), workflow: WF, me, cfg: cfg(), iterations: [] }).refused, "sc-7 is done. Follow-up work belongs in a new story.");
});
test("startDecision: stale state id asks again and is dropped; missing asks", () => {
  const stale = startDecision({ story: story(), workflow: WF, me, cfg: cfg({ startStates: { 1: 999 } }), iterations: [] });
  assert.deepEqual([stale.askState, stale.dropStale, stale.patch], [true, true, null]);
  assert.deepEqual(startDecision({ story: story(), workflow: WF, me, cfg: cfg({ startStates: {} }), iterations: [] }).askState, true);
});
test("startDecision: iteration never, and iteration notes", () => {
  assert.equal(startDecision({ story: story(), workflow: WF, me, cfg: cfg({ iteration: "never" }), iterations: [{ id: 1, status: "started", group_ids: [] }] }).patch.iteration_id, undefined);
  const d = startDecision({ story: story({ group_id: null }), workflow: WF, me, cfg: cfg(), iterations: [{ id: 1, status: "started", group_ids: [] }, { id: 2, status: "started", group_ids: [] }] });
  assert.deepEqual(d.notes, ["iteration not set: 2 started iterations, none chosen"]);
});
test("currentIteration: ambiguous, none, one", () => {
  assert.deepEqual(currentIteration(story({ group_id: null }), [{ id: 1, status: "started", group_ids: [] }, { id: 2, status: "started", group_ids: ["g"] }]), { reason: "2 started iterations, none chosen" });
  assert.deepEqual(currentIteration(story(), [{ id: 1, status: "done", group_ids: ["g"] }]), { reason: "no started iteration for this team" });
  assert.deepEqual(currentIteration(story(), [{ id: 1, status: "started", group_ids: ["g"] }, { id: 2, status: "started", group_ids: ["h"] }]), { id: 1 });
});
test("branchCandidates: open PR, then story branch, then template", () => {
  const vars = storyVars(story(), { mention_name: "jer" });
  assert.deepEqual(branchCandidates(story({ pull_requests: [{ branch_name: "p1", merged: false, closed: false }, { branch_name: "p2", merged: true, closed: true }], branches: [{ name: "b1" }] }), cfg(), vars), { level: "pr", candidates: ["p1"], checkout: "existing" });
  assert.deepEqual(branchCandidates(story({ branches: [{ name: "b1" }, { name: "b1" }, { name: "b2" }] }), cfg(), vars), { level: "story", candidates: ["b1", "b2"], checkout: "existing" });
  assert.deepEqual(branchCandidates(story(), cfg(), vars), { level: "template", candidates: ["jer/sc-7/x"], checkout: "new" });
});
test("repoHints from branch and PR urls", () => {
  assert.deepEqual(repoHints(story({ branches: [{ url: "https://github.com/org/api/tree/b1" }], pull_requests: [{ url: "https://github.com/org/api/pull/3" }, { url: "https://github.com/org/web.git/pull/1" }] })), { names: ["api", "web"], urls: ["https://github.com/org/api", "https://github.com/org/web.git"], folder: null });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/start.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `start.js`**

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/start.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mods/shortcut/start.js test/start.test.mjs
git commit -m "Start rules: state, owners, iteration, branch choice, repo hints"
```

---

### Task 5: The launch request and the launcher handoff (`launch.js`)

**Files:**
- Create: `mods/shortcut/launch.js`
- Test: `test/launch.test.mjs`

**Interfaces:**
- Consumes: `repoHints` (Task 4).
- Produces:
  - `buildLaunchRequest({ story, branch, checkout, prompt, hints }) → launch` = `{ v: 1, branch, checkout, name: "sc-<id> · <name>", prompt: prompt || null, source: { kind: "shortcut", id: "sc-<id>", url: story.app_url, title: story.name }, repo: hints }`.
  - `backTo(story) → { mod: "shortcut", props: { screen: "story", id: story.id } }`.
  - `spaceFolder(space, panes) → string|null`: the cwd of the first pane whose tab is in the space, else `space.folder` (herdr-linear's `place`).
  - `shippedPreflight({ space, panes, exec }) → Promise<{ folder, top } | { error }>`: no space → `error: "Select a space in the repo first, or choose a launcher mod in settings"`; `git -C <folder> rev-parse --show-toplevel` failing → same message.
  - `shippedProps({ space, folder, branch }) → { mod: "worktree", kind: "dialog", props: { folder, machine: null, branch, space: space.id } }`.
  - `launcherExists(name, readTextFile) → Promise<boolean>` (reads `${appHome()}/mods/<name>/main.js`).
  - `openLauncher({ cfg, launch, back, space, panes, exec, openOverlay, readTextFile }) → Promise<{ ok: true, note: string|null } | { error }>`: shipped → preflight then `openOverlay(shippedProps(...))`, `note` = `"the shipped dialog can't fetch a remote-only branch"` when `launch.checkout === "existing"` and `git -C <top> rev-parse --verify --quiet refs/heads/<branch>` fails; mod → `launcherExists` else `error: 'launcher "<name>" is not installed'`, then `openOverlay({ mod: name, kind: "dialog", width: 0.8, height: 0.8, props: { launch, backTo: back } })`.

- [ ] **Step 1: Write the failing tests**

```js
// test/launch.test.mjs
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/launch.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `launch.js`**

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/launch.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mods/shortcut/launch.js test/launch.test.mjs
git commit -m "Launch request, shipped-dialog preflight and the mod handoff"
```

---

### Task 6: The view: load, Mine list, filter, sign-in (`main.js`)

**Files:**
- Modify: `mods/shortcut/main.js` (replace the stub)
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `load, save, resolveToken, storyVars` (Task 2); `createClient, readCache, writeCache, fresh` (Task 3); `tones, icon, chip, key, stateIcon, stateColor, countPill` (Task 1).
- Produces on the view: `this.screen` ∈ `list | story | create | settings | pickState | signIn`; `this.tab` ∈ `mine | team | epics | recent` (persisted in `localStorage` key `tab`); `this.cfg`, `this.raw`, `this.client` (null until a token resolves), `this.ref` = `{ me, workflows, groups, epics, iterations, customFields }` (each `{ at, data }`), `this.lists[tab]` = `{ at, data, cut }`; `this.busy`, `this.err`, `this.flash` (one note line as herdr-linear); methods `boot(cx)` (load settings → token → client → `readCache` → render → `refreshAll(cx)`), `refreshAll(cx)` (reference data older than 10 min, the current tab older than 60 s), `load(tab, cx)`, `shownRows()` (`{ header }` and `{ story }` rows grouped by state in workflow position order, filtered by `this.filter` over `sc-<id>`, name, epic name, labels), `lookUp(cx)` (filter matching `/^(?:sc-|#)?(\d{1,9})$/i` fetches that story and offers it as the first row), `stateOf(story)` → the state object, `workflowOf(story)`, `say(text, cx, isErr)`, `escape(cx)`, `dismiss()`, `listKey(k, cx)`, `footer(o)`.
- Key handling as herdr-linear: filter input's submit = Enter; `on_key_down` in `render` dispatches by screen; `nextCommand()` loop handles `escape`, `tab`, `backtab`.

- [ ] **Step 1: Write the failing tests**

```js
// test/ui.test.mjs (append). A `routes` helper `basic()` returns: GET /member → { id: "me", mention_name: "jer", name: "Jer" }; GET /workflows → [WF from Task 4's test]; GET /groups, /epics, /iterations, /custom-fields → []; POST /stories/search → { data: [S(1,"Alpha",11), S(2,"Beta",12)], next: null } where S(id,name,state) builds a story with workflow_id 1 and owner_ids ["me"].
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
test("Esc closes from the list, and the footer lists the keys", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  assert.match(texts(v), /start/); assert.match(texts(v), /settings/);
  pushCommand("escape"); await cx.settle();
  assert.equal(state.closed, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/ui.test.mjs`
Expected: FAIL (stub view has no list).

- [ ] **Step 3: Implement the view's list and boot**

Port herdr-linear's `init`, `render`, `listView`, `issueCard` (→ `storyCard`), `tabBar`, `footer`, `signInView`, `say/escape/dismiss` shapes; the `ask()`/`job()` binary layer is replaced by `this.client`. Row chips: epic name, iteration name, labels, `countPill` for PR count, priority value when `cfg.priorityField` is set. Cache keys: `member, workflows, groups, epics, iterations, customFields, lists.<tab>`.

- [ ] **Step 4: Run to verify they pass, and check the mod**

Run: `node --test test/*.test.mjs && herdr-app check mods/shortcut`
Expected: PASS; no check error.

- [ ] **Step 5: Commit**

```bash
git add mods/shortcut/main.js test/ui.test.mjs test/helpers
git commit -m "The popup: boot from cache, Mine list, filter and key lookup, sign-in"
```

---

### Task 7: Team, Epics and Recent tabs

**Files:**
- Modify: `mods/shortcut/main.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces: `this.group` (chosen team id, `localStorage` key `group`, default my first group); `this.drilled` (an epic whose stories are listed, as herdr-linear's `drilled`); `load("team")` → `searchStories({ group_ids: [group], workflow_state_types: ["started"], archived: false })`; `load("epics")` → `epics()` rows `{ epic }`; `load("epic:<id>")` → `searchStories({ epic_ids: [id], archived: false })`; `load("recent")` → `story(id)` for each of `cfg.recent` (cached stories reused when fresh within 10 min), archived shown dimmed; `1..4` and `←`/`→` switch tabs.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run to verify they fail** — `node --test test/ui.test.mjs`, FAIL.
- [ ] **Step 3: Implement the tabs.**
- [ ] **Step 4: Run to verify they pass** — `node --test test/*.test.mjs && herdr-app check mods/shortcut`, PASS.
- [ ] **Step 5: Commit** — `git commit -am "Team, Epics and Recent tabs"`

---

### Task 8: The story screen, state and priority menus

**Files:**
- Modify: `mods/shortcut/main.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces: `openStory(story, cx)` (screen `story`, `this.cur` = story, refetches `story(id)` in the background and replaces the row), `storyView(o)`, `this.menu` = `{ kind: "state"|"priority"|"branch"|"launcher", items: [{ label, value }], at }` and `menuView(o)` / `choose(item, cx)` (herdr-linear's shape); `t` opens the state menu (the workflow's states, current chosen) → `updateStory(id, { workflow_state_id })`; `p` opens the priority menu when `cfg.priorityField` is set → `updateStory(id, { custom_fields: [{ field_id, value_id }] })`; `o` → `cx.open_url(app_url)`; `y` copies `sc-<id>`; `b` copies the branch the start would use (first candidate); `g` on a PR row opens it (browser, or the github mod as a dialog with `backTo` when `${appHome()}/mods/github/main.js` exists, props `{ pr: { host, repo, number }, backTo }` as the github mod's own `openIssue` shows); `s` starts (Task 9); Esc → `back(cx)` (returns to the list on the story's row, or to `props().backTo`'s opener when opened with `props().screen === "story"`).
- Opening with props: `init` honors `props().screen === "story" && props().id` by opening that story once the client is ready (the `backTo` round trip from a launcher).

- [ ] **Step 1: Write the failing tests**

```js
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
  press(v, cx, "down"); press(v, cx, "down"); press(v, cx, "enter"); await cx.settle();
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
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement the story screen and menus.** Port `issueView`, `menuView`, `statusMenu`, `choose`, `issueKey` from herdr-linear.
- [ ] **Step 4: Run to verify they pass** — `node --test test/*.test.mjs && herdr-app check mods/shortcut`, PASS.
- [ ] **Step 5: Commit** — `git commit -am "The story screen with state and priority menus"`

---

### Task 9: Start, pickState and the branch menu

**Files:**
- Modify: `mods/shortcut/main.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Consumes: `startDecision, branchCandidates, repoHints` (Task 4); `buildLaunchRequest, backTo, openLauncher` (Task 5); `save` (Task 2).
- Produces: `startStory(story, cx)`: busy line `Starting sc-<id>…`; steps per spec 8.1: refetch → `startDecision` → refused: `say(refused, cx, true)`; `askState`: screen `pickState` with `this.pick = { story, workflow, resume }`, Enter persists `cfg.startStates[workflow.id]` (dropping a stale id), saves, resumes; patch → `updateStory`; `branchCandidates` with several → `this.menu = { kind: "branch", ... }` and resume with the chosen; prompt = `expand(cfg.startPrompt, storyVars(story, me, branch))`; push to `cfg.recent` (dedupe by id, newest first, 30) and save; `openLauncher`; `{ error }` → `say(error, cx, true)`; `{ ok, note }` → `note` flashed via `notify`-less `say` then `dismiss()` (the popup closes; a note is shown for 1.5 s with `cx.timer.after` before closing only when `note` is non-null). `s` from the list starts the highlighted story; `s` on the story screen starts `this.cur`.

- [ ] **Step 1: Write the failing tests**

```js
test("start: updates Shortcut, records recent, opens the configured mod launcher, closes", async () => {
  mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, "");
  const iter = [{ id: 99, name: "It 9", status: "started", group_ids: ["g"] }];
  const routes = { ...basic(), "GET /iterations": iter, "GET /stories/1": { ...S(1, "Alpha", 11), owner_ids: ["other"], group_id: "g" }, "PUT /stories/1": (b) => ({ ...S(1, "Alpha", b.workflow_state_id), owner_ids: b.owner_ids }) };
  const { v, cx, fetch } = await open({ cfg: { auth: { token: "T" }, startStates: { 1: 12 }, launcher: { kind: "mod", name: "projects" } }, routes });
  press(v, cx, "s"); await cx.settle();
  assert.deepEqual(fetch.calls.find((c) => c.method === "PUT").body, { workflow_state_id: 12, owner_ids: ["other", "me"], iteration_id: 99 });
  const o = state.overlays.at(-1);
  assert.equal(o.mod, "projects");
  assert.deepEqual(o.props.launch, { v: 1, branch: "jer/sc-1/alpha", checkout: "new", name: "sc-1 · Alpha", prompt: "Read the shortcut story sc-1 for context, then suggest how to proceed.", source: { kind: "shortcut", id: "sc-1", url: undefined, title: "Alpha" }, repo: { names: [], urls: [], folder: null } });
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
```
(`open()` gains a `space` option that pushes the space into `state.spaces` with `active: true`; the view takes the selected space as `spaces().find((s) => s.active)`.)

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement `startStory`, `pickStateView`, the branch menu.**
- [ ] **Step 4: Run to verify they pass** — `node --test test/*.test.mjs && herdr-app check mods/shortcut`, PASS.
- [ ] **Step 5: Commit** — `git commit -am "Start a story: Shortcut updates, start-state prompt, branch choice, launcher handoff"`

---

### Task 10: Create a story

**Files:**
- Modify: `mods/shortcut/main.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces: `create(cx)` (screen `create`, `this.form = { name, desc, group, state, type, epic, iteration, mine, priority }` with `InputState`s for name and description and chip rows for the rest, defaults per spec section 6: group = my first group, state = that group's workflow's first `unstarted` state (fallback: the first workflow's), type `feature`, `mine: true`); `submit(cx)` → `createStory({ name, description, group_id, workflow_state_id, story_type, owner_ids: mine ? [me] : [], epic_id?, iteration_id?, custom_fields? })` then `openStory(created)` with the flash `Created sc-<id>. Press s to start it.`; ctrl+Enter submits; Tab/Shift-Tab via `nextCommand` move between name and description; `n` opens it from the list and the story screen.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement the create screen.** Port `create`, `createView`, `submit`, `pickTeam` from herdr-linear; groups carry `workflow_ids` in v3, use the first.
- [ ] **Step 4: Run to verify they pass** — `node --test test/*.test.mjs && herdr-app check mods/shortcut`, PASS.
- [ ] **Step 5: Commit** — `git commit -am "Create a story from the popup"`

---

### Task 11: Settings screen

**Files:**
- Modify: `mods/shortcut/main.js`
- Test: `test/ui.test.mjs`

**Interfaces:**
- Produces: `settings(cx)` (screen `settings`), `settingsView(o)` with the rows of spec section 6 in order: auth (two chips `Environment variable` / `Token`, an `InputState` for the name or the paste box, `Test` runs `me()` and flashes the member's name or the error, `Clear` drops the token), start prompt (`TextareaState`), branch name (`InputState` plus a live preview for `{ id: 1234, name: "Sample story" }`), one row per workflow with a `launcher`-style menu of its non-done states and the first item `Please select a start state`, iteration (two chips), priority field (menu: `None` + enabled fields with values), launcher (menu: `Shipped worktree dialog` + `Mod: <name>` per `exec("ls", [`${appHome()}/mods`])` entry whose `main.js` exists, plus the current value when it is not listed). Every change → `saveSettings(cx)` debounced with `cx.timer.after(300)`, flashing `Saved` or the error; a settings `error` from `load()` is shown at the top. `,` opens settings from the list and story screens.

- [ ] **Step 1: Write the failing tests**

```js
test("settings: token masked, env name editable, Test shows the member", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "abcdef1234" } }, routes: basic() });
  press(v, cx, ","); assert.equal(v.screen, "settings");
  assert.match(texts(v), /••••1234/); assert.doesNotMatch(texts(v), /abcdef1234/);
  v.testToken(cx); await cx.settle(); assert.match(v.flash, /Jer/);
});
test("settings: start states per workflow with the placeholder, saved on change", async () => {
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
  press(v, cx, ","); assert.match(texts(v), /Eng[\s\S]*Please select a start state/);
  v.openStateMenu(1, cx); assert.deepEqual(v.menu.items.map((i) => i.label), ["Please select a start state", "Backlog", "Ready", "In Dev", "In Review"]);
  press(v, cx, "down"); press(v, cx, "down"); press(v, cx, "down"); press(v, cx, "enter"); cx.fire(300); await cx.settle();
  assert.deepEqual(JSON.parse(readFileSync(dataPath(), "utf8")).startStates, { 1: 12 });
});
test("settings: the launcher menu lists installed mods and the shipped dialog", async () => {
  mkdirSync(`${state.appHome}/mods/projects`, { recursive: true }); writeFileSync(`${state.appHome}/mods/projects/main.js`, "");
  mkdirSync(`${state.appHome}/mods/empty`, { recursive: true });
  const { v, cx } = await open({ cfg: { auth: { token: "T" } }, routes: basic() });
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
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement the settings screen.**
- [ ] **Step 4: Run to verify they pass** — `node --test test/*.test.mjs && herdr-app check mods/shortcut`, PASS.
- [ ] **Step 5: Commit** — `git commit -am "Settings: auth, prompt, branch, start states, iteration, priority, launcher"`

---

### Task 12: Install, docs, live verification

**Files:**
- Create: `RECIPE.md` (install steps, modeled on herdr-projects'), update `README.md` (what you see, keys, settings, the launch contract pointer)
- Modify: `~/.config/herdr-app/mods/shortcut/` (copy), `~/.config/herdr-app/keys.json` (merge `keys.json`), `~/.config/herdr-app/CUSTOMIZATIONS.md` (new entry)

- [ ] **Step 1: Write RECIPE.md and README.md.** RECIPE: copy `mods/shortcut` to `~/.config/herdr-app/mods/shortcut`, merge `keys.json` (`global` and `mod:shortcut` sections), `herdr-app check ~/.config/herdr-app/mods/shortcut`, open with `cmd-alt-s`, first-run: settings → auth. Note the launcher choice and that `projects` needs its launch-by-props version.

- [ ] **Step 2: Install.** Run the recipe. Expected: `herdr-app check` clean; `cmd-alt-s` opens the popup showing Mine from the real workspace (the shell's `SHORTCUT_API_TOKEN`). `herdr-app shot` of list, story, settings, pickState.

- [ ] **Step 3: Live verification, read-only first.** Open a story, change tabs, filter by `sc-<id>`. Expected: data matches the web UI.

- [ ] **Step 4: Live verification of Start, on a story the person names.** Ask the person for a throwaway story id before any write. With launcher `Mod: projects` and that story: press `s`. Expected: in the web UI the state is the configured start state, the person is an owner, the iteration is set when one fit; the projects launch screen shows the branch and prompt; Enter makes the worktree and space and the agent receives the prompt. Then with launcher `Shipped worktree dialog`, from a space in the repo: `s` on the same story. Expected: a note that nothing changed on Shortcut (state kept, already owner), the worktree dialog opens on the branch, a shell opens in the new worktree.

- [ ] **Step 5: Ledger.** Add to `~/.config/herdr-app/CUSTOMIZATIONS.md`: the `shortcut` mod (source repo, version, keys added, data files), dated 2026-11-04.

- [ ] **Step 6: Commit**

```bash
git add RECIPE.md README.md && git commit -m "Install recipe and README"
```
