// Settings file (data/shortcut.json), API token lookup and template expansion.
import { appHome, exec, readTextFile, writeTextFile } from "herdr";

export const DEFAULTS = {
  auth: { env: "SHORTCUT_API_TOKEN" },
  startPrompt: "Read the shortcut story {id} for context, then suggest how to proceed.",
  branchTemplate: "{mention}/sc-{number}/{slug}",
  startStates: {},
  iteration: "current-if-unset",
  priorityField: null,
  launcher: { kind: "shipped" },
  recent: [],
};

const ITERATIONS = ["current-if-unset", "never"];
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
/** A name that can be an environment variable (and so is interpolated into the shell safely). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Absolute path of the settings file. */
export const dataPath = () => `${appHome()}/data/shortcut.json`;

/** Fill every default, drop unknown keys, coerce odd values back to something valid. */
export function normalize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const a = r.auth && typeof r.auth === "object" ? r.auth : {};
  const auth = typeof a.token === "string" && a.token.trim() !== ""
    ? { token: a.token }
    : { env: typeof a.env === "string" && ENV_NAME.test(a.env) ? a.env : DEFAULTS.auth.env };
  const startStates = {};
  if (r.startStates && typeof r.startStates === "object") {
    for (const [k, v] of Object.entries(r.startStates)) {
      const n = Number(v);
      if (v !== null && v !== "" && Number.isInteger(n)) startStates[String(k)] = n;
    }
  }
  const l = r.launcher;
  const launcher = l && l.kind === "shipped" ? { kind: "shipped" }
    : l && l.kind === "mod" && nonEmpty(l.name) ? { kind: "mod", name: l.name }
    : { kind: "shipped" };
  return {
    auth,
    startPrompt: nonEmpty(r.startPrompt) ? r.startPrompt : DEFAULTS.startPrompt,
    branchTemplate: nonEmpty(r.branchTemplate) ? r.branchTemplate : DEFAULTS.branchTemplate,
    startStates,
    iteration: ITERATIONS.includes(r.iteration) ? r.iteration : DEFAULTS.iteration,
    priorityField: nonEmpty(r.priorityField) ? r.priorityField : null,
    launcher,
    recent: Array.isArray(r.recent)
      ? r.recent.filter((e) => e && Number.isFinite(e.id)).slice(0, 30)
      : [],
  };
}

/** Read the settings file; a missing file gives defaults, a broken one gives defaults plus an error. */
export async function load() {
  const raw = await readTextFile(dataPath());
  if (raw == null) return { cfg: normalize(null), raw: null, error: null };
  try {
    return { cfg: normalize(JSON.parse(raw)), raw, error: null };
  } catch (e) {
    // The parser's message can quote file text (and the file may hold the token), so only a position is kept.
    const pos = /position \d+/.exec(String(e.message))?.[0];
    return { cfg: normalize(null), raw, error: `data/shortcut.json is not valid JSON: ${pos ?? "check the file"}` };
  }
}

/** Write the settings (compare-and-write against the previous text); returns the text written. */
export async function save(cfg, raw) {
  const text = JSON.stringify(cfg, null, 2) + "\n";
  await writeTextFile(dataPath(), text, raw);
  if (cfg.auth && cfg.auth.token) {
    const r = await exec("chmod", ["600", dataPath()]);
    if (r.code !== 0) throw new Error("could not restrict data/shortcut.json to mode 600");
  }
  return text;
}

/** The API token: the pasted one, else the named environment variable read through a login shell. */
export async function resolveToken(cfg) {
  if (cfg.auth.token) return { token: String(cfg.auth.token).trim(), error: null };
  const name = cfg.auth.env;
  // The name is not echoed: a token pasted in its place would be shown.
  if (!ENV_NAME.test(name)) return { token: "", error: "Not an environment variable name" };
  const r = await exec("sh", ["-lc", 'printf %s "$' + name + '"']);
  return { token: String(r.stdout ?? "").trim(), error: null };
}

/** Lowercase, dash-separated, at most 48 characters, never ending in a dash. */
export function slug(text) {
  const s = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 48).replace(/-+$/, "");
  return s || "story";
}

/** Template variables for a story. */
export function storyVars(story, me, branch = "") {
  return {
    id: `sc-${story.id}`,
    number: String(story.id),
    slug: slug(story.name),
    title: story.name ?? "",
    url: story.app_url ?? "",
    mention: me?.mention_name ?? "",
    branch,
  };
}

/** Replace {word} with vars[word]; unknown words stay as typed. */
export function expand(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, w) => (Object.hasOwn(vars, w) ? String(vars[w]) : m));
}
