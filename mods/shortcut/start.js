// Pure Start rules (spec 8.1 steps 4 and 6): no I/O.
import { expand } from "./config.js";

const uniq = (xs) => [...new Set(xs)];

// The one started iteration for the story's team, or the reason there isn't one.
export function currentIteration(story, iterations) {
  const hit = (iterations || []).filter((it) => it.status === "started"
    && (story.group_id == null || !it.group_ids?.length || it.group_ids.includes(story.group_id)));
  if (hit.length === 1) return { id: hit[0].id };
  if (hit.length === 0) return { reason: "no started iteration for this team" };
  return { reason: `${hit.length} started iterations, none chosen` };
}

// Decide what Start refuses, asks, or changes on the story.
export function startDecision({ story, workflow, me, cfg, iterations }) {
  const out = { refused: null, askState: false, dropStale: false, notes: [], patch: null };
  const sc = `sc-${story.id}`;
  if (story.archived) return { ...out, refused: `${sc} is archived.` };
  const states = workflow.states || [];
  const current = states.find((s) => s.id === story.workflow_state_id);
  if (current?.type === "done") return { ...out, refused: `${sc} is done. Follow-up work belongs in a new story.` };

  const startId = cfg.startStates?.[String(workflow.id)];
  if (startId == null) return { ...out, askState: true };
  if (!states.some((s) => s.id === startId)) return { ...out, askState: true, dropStale: true };

  const patch = {};
  if (current?.type === "backlog" || current?.type === "unstarted") patch.workflow_state_id = startId;
  else out.notes.push(`state kept: ${current ? current.name : "unknown"}`);

  const owners = story.owner_ids || [];
  if (!owners.includes(me.id)) patch.owner_ids = [...owners, me.id];

  if (cfg.iteration === "current-if-unset" && story.iteration_id == null) {
    const it = currentIteration(story, iterations);
    if (it.id != null) patch.iteration_id = it.id;
    else out.notes.push(`iteration not set: ${it.reason}`);
  }
  out.patch = Object.keys(patch).length ? patch : null;
  return out;
}

// Pick the branch level: open PR, else story branch, else the template.
export function branchCandidates(story, cfg, vars) {
  const pr = uniq((story.pull_requests || []).filter((p) => p.merged === false && p.closed === false && p.branch_name).map((p) => p.branch_name));
  if (pr.length) return { level: "pr", candidates: pr, checkout: "existing" };
  const sb = uniq((story.branches || []).map((b) => b.name).filter(Boolean));
  if (sb.length) return { level: "story", candidates: sb, checkout: "existing" };
  return { level: "template", candidates: [expand(cfg.branchTemplate, vars)], checkout: "new" };
}

// Repo names and urls implied by the story's branch and PR urls.
export function repoHints(story) {
  const raw = [...(story.branches || []), ...(story.pull_requests || [])].map((x) => x.url).filter(Boolean);
  const urls = uniq(raw.map((u) => u.split(/\/(?:pull|tree)\//)[0]));
  const names = uniq(urls.map((u) => u.split("/").filter(Boolean).pop().replace(/\.git$/, "")));
  return { names, urls, folder: null };
}
