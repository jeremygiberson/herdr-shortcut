import "./helpers/setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { WF } from "./helpers/fixtures.mjs";
const { normalize, storyVars } = await import("../mods/shortcut/config.js");
const { startDecision, currentIteration, branchCandidates, repoHints } = await import("../mods/shortcut/start.js");

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
test("startDecision: done and archived are refused", () => {
  assert.equal(startDecision({ story: story({ workflow_state_id: 14 }), workflow: WF, me, cfg: cfg(), iterations: [] }).refused, "sc-7 is done. Follow-up work belongs in a new story.");
  assert.equal(startDecision({ story: story({ archived: true }), workflow: WF, me, cfg: cfg(), iterations: [] }).refused, "sc-7 is archived.");
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
