// The launch request (spec section 7) and the handoff to a launcher.
import { appHome } from "herdr";

const NO_SPACE = "Select a space in the repo first, or choose a launcher mod in settings";

/** Builds the v1 launch request the launcher receives. */
export function buildLaunchRequest({ story, branch, checkout, prompt, hints }) {
  return {
    v: 1, branch, checkout,
    name: `sc-${story.id} · ${story.name}`,
    prompt: prompt || null,
    source: { kind: "shortcut", id: `sc-${story.id}`, url: story.app_url, title: story.name },
    repo: hints,
  };
}

/** Where the launcher's dialog returns to: this story's screen. */
export function backTo(story) {
  return { mod: "shortcut", props: { screen: "story", id: story.id } };
}

/** The cwd of the space's first live pane, else the space's folder, else null. */
export function spaceFolder(space, panes) {
  const tabs = new Set((space.tabs || []).map((t) => t.id));
  const pane = (panes || []).find((p) => tabs.has(p.tab));
  return pane?.cwd || space.folder || null;
}

/** Checks a space is selected and sits in a git repo; gives { folder, top } or { error }. */
export async function shippedPreflight({ space, panes, exec }) {
  if (!space) return { error: NO_SPACE };
  const folder = spaceFolder(space, panes);
  if (!folder) return { error: NO_SPACE };
  const r = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) return { error: NO_SPACE };
  return { folder, top: r.stdout.trim() };
}

/** The props for Herdr's own worktree dialog. */
export function shippedProps({ space, folder, branch }) {
  return { mod: "worktree", kind: "dialog", props: { folder, machine: null, branch, space: space.id } };
}

/** True when the named launcher mod is installed (its main.js exists). */
export async function launcherExists(name, readTextFile) {
  if (!name || name.includes("/") || name.includes("..")) return false;
  return typeof (await readTextFile(`${appHome()}/mods/${name}/main.js`)) === "string";
}

/** Opens the configured launcher with the request; { ok, note } or { error }. */
export async function openLauncher({ cfg, launch, back, space, panes, exec, openOverlay, readTextFile }) {
  if (cfg.launcher.kind === "mod") {
    const name = cfg.launcher.name;
    if (!(await launcherExists(name, readTextFile))) return { error: `launcher "${name}" is not installed` };
    openOverlay({ mod: name, kind: "dialog", width: 0.8, height: 0.8, props: { launch, ...(back ? { backTo: back } : {}) } });
    return { ok: true, note: null };
  }
  const pre = await shippedPreflight({ space, panes, exec });
  if (pre.error) return pre;
  let note = null;
  if (launch.checkout === "existing") {
    const r = await exec("git", ["-C", pre.top, "rev-parse", "--verify", "--quiet", `refs/heads/${launch.branch}`]);
    if (r.code !== 0) note = "the shipped dialog can't fetch a remote-only branch";
  }
  openOverlay(shippedProps({ space, folder: pre.folder, branch: launch.branch }));
  return { ok: true, note };
}
