import { appHome, exec, readTextFile, writeTextFile } from "herdr";

const ORIGIN = "https://api.app.shortcut.com";

/** An HTTP failure from Shortcut; never carries request headers or the token. */
export class ApiError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Parses a Retry-After header as seconds, defaulting to 2. */
function retrySeconds(res) {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n >= 0 && res.headers.get("retry-after") !== null ? n : 2;
}

/** Builds a Shortcut v3 client; fetch and wait are injectable for tests. */
export function createClient({ token, fetch = globalThis.fetch, wait = (s) => exec("sleep", [String(s)]) }) {
  /** Sends one request (retrying a single 429) and returns the parsed JSON. */
  async function api(method, path, body) {
    const url = path.startsWith("/api/v3") ? `${ORIGIN}${path}` : `${ORIGIN}/api/v3${path}`;
    const init = { method, headers: { "Shortcut-Token": token, "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res = await fetch(url, init);
    if (res.status === 429) {
      await wait(retrySeconds(res));
      res = await fetch(url, init);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.status === 429) throw new ApiError("Shortcut: HTTP 429 (rate limited)", 429, retrySeconds(res));
    if (!res.ok) {
      const msg = data && typeof data.message === "string" && data.message ? data.message : `Shortcut: HTTP ${res.status}`;
      throw new ApiError(msg, res.status);
    }
    return data;
  }

  return {
    me: () => api("GET", "/member"),
    workflows: () => api("GET", "/workflows"),
    groups: async () => (await api("GET", "/groups")).filter((g) => g.archived === false),
    epics: async () => (await api("GET", "/epics")).filter((e) => e.archived === false && e.completed === false),
    iterations: () => api("GET", "/iterations"),
    customFields: async () => (await api("GET", "/custom-fields")).filter((f) => f.enabled === true),
    story: (id) => api("GET", `/stories/${id}`),
    /** Searches stories. v3's POST /stories/search answers with a plain array (no paging); a paged
     *  `{ data, next }` answer is followed through `next` up to `pages` pages. */
    async searchStories(body, { pages = 4 } = {}) {
      const data = [];
      let path = "/stories/search";
      let next = null;
      for (let i = 0; i < pages && path; i++) {
        const page = await api("POST", path, body);
        if (Array.isArray(page)) return { data: page, cut: false };
        data.push(...(page?.data ?? []));
        next = page?.next ?? null;
        path = next;
      }
      return { data, cut: Boolean(next) };
    },
    textSearch: async (query, pageSize = 25) =>
      (await api("GET", `/search/stories?query=${encodeURIComponent(query)}&page_size=${pageSize}`))?.data,
    updateStory: (id, patch) => api("PUT", `/stories/${id}`, patch),
    createStory: (params) => api("POST", "/stories", params),
  };
}

/** Path of the shared lookup cache file. */
export function cachePath() {
  return `${appHome()}/data/shortcut-cache.json`;
}

/** Reads the cache object; `{}` when missing, unreadable or broken. */
export async function readCache() {
  try {
    const v = JSON.parse(await readTextFile(cachePath()));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Writes the cache object as pretty JSON (last writer wins). */
export async function writeCache(obj) {
  const current = await readTextFile(cachePath());
  await writeTextFile(cachePath(), JSON.stringify(obj, null, 2), current);
}

/** True when `entry` has a numeric `at` no older than `maxMs`. */
export function fresh(entry, maxMs, now = Date.now()) {
  return Boolean(entry) && typeof entry === "object" && typeof entry.at === "number" && now - entry.at <= maxMs;
}
