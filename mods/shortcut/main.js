// The Shortcut popup: your stories, a filter that also finds any story by its key, and (in later screens) a story,
// a new story and the settings. One View; `this.screen` says which screen is drawn. Ported from herdr-linear's view,
// with its binary layer replaced by the Shortcut API client.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, nextCommand, appHome, readTextFile, spaces, panes, exec } from "herdr";
import { load as loadSettings, save as saveSettings, resolveToken, normalize, storyVars, expand, DEFAULTS, ENV_NAME } from "./config.js";
import { createClient, ApiError, readCache, writeCache, fresh } from "./api.js";
import { startDecision, branchCandidates, repoHints } from "./start.js";
import { buildLaunchRequest, backTo, launcherReady, openLauncher } from "./launch.js";
import { tones, tint, icon, chip, key, countPill, stateIcon, stateColor, MONO } from "./look.js";

const TABS = [
  { id: "mine", label: "Mine", icon: "person" },
  { id: "team", label: "Team", icon: "server" },
  { id: "epics", label: "Epics", icon: "branch" },
  { id: "recent", label: "Recent", icon: "calendar" },
];

// A story's key typed in the filter ("sc-1234", "#1234" or 1234): looked up in the whole workspace.
const STORY_KEY = /^(?:sc-|#)?(\d{1,9})$/i;

// The reference data kept in the cache, each with the client call that fetches it.
const REF = ["member", "workflows", "groups", "epics", "iterations", "customFields"];
const CALL = { member: "me", workflows: "workflows", groups: "groups", epics: "epics", iterations: "iterations", customFields: "customFields" };
const REF_MAX = 10 * 60 * 1000;
const LIST_MAX = 60 * 1000;

// The list's heights: a heading's, a row's (34 and a gap), and the most it takes before it scrolls.
const HEADING_H = 30;
const ROW_H = 36;
const LIST_H = 560;

// A pull request's url, https://<host>/<owner>/<name>/pull/<n>: the host and the repo the github mod takes.
const PR_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/;

const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

// The states a start may move a story to: unstarted and started ones (never backlog, never done), in position order.
const startable = (workflow) => [...(workflow?.states ?? [])].filter((x) => x.type === "unstarted" || x.type === "started").sort(byPosition);

// The key as a binding spells it ("ctrl-s", "escape"): the event's own spelling when it has one.
function chord(e) {
  if (e.keystroke) return e.keystroke;
  const m = e.modifiers ?? {};
  return [m.control && "ctrl", m.alt && "alt", m.shift && "shift", m.platform && "cmd", e.key].filter(Boolean).join("-");
}

export default class Shortcut extends View {
  init(_props, cx) {
    this.cx = cx;
    const p = props() ?? {};
    // Where esc goes back to, when another mod opened this one.
    this.backTo = p.backTo ?? null;
    // A story to open straight away (props { screen: "story", id }).
    this.openWith = p.screen === "story" && p.id ? p.id : null;

    this.screen = "list";
    this.tab = localStorage.getItem("tab") ?? "mine";
    if (!TABS.some((t) => t.id === this.tab)) this.tab = "mine";
    this.group = localStorage.getItem("group") ?? null; // the chosen team (a group id)
    this.drilled = null; // the epic whose stories the Epics tab lists
    this.cfg = normalize(null);
    this.raw = null;
    this.cfgError = null;
    this.client = null;
    this.cache = {};
    this.ref = {};
    this.lists = {};
    this.loading = new Set();
    this.refreshing = false;
    this.signInNote = "";
    this.filter = "";
    this.found = null; // the story whose key is in the filter
    this.searched = null; // { query, data }: the workspace's answer to the filter
    this.searchSeq = 0;
    this.at = 0;
    this.cur = null;
    this.menu = null; // { kind: "state"|"priority"|"pickState"|"branch"|"startState"|"cfgPriority"|"launcher", items: [{ label, value }], at }
    this.saveSeq = 0; // the settings' debounced save: only the last one scheduled runs
    this.pick = null; // a start waiting on pickState: { story, workflow, resume, from }
    this.branching = null; // a start waiting on the branch menu: { story, resume }
    this.prAt = -1; // the story screen's highlighted pull request (-1: none)
    this.github = false; // the github mod is installed: a story's pull requests open there
    this.typing = false;
    this.flash = this.err = this.busy = "";

    this.focus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Filter, or a story's key (sc-1234)…" });
    this.input.on("change", () => {
      this.filter = this.input.value();
      this.at = 0;
      this.lookUp(this.cx);
      this.cx.notify();
    });
    this.input.on("submit", () => this.enter(this.cx));
    this.input.on("focus", () => (this.typing = true));
    this.input.on("blur", () => (this.typing = false));
    this.focus.focus?.();
    cx.timer.after(300, () => this.screen === "list" && !this.typing && this.focus.focus?.());

    cx.spawn(async (cx) => {
      try {
        await this.boot(cx);
      } catch (e) {
        this.fail("boot", e);
      }
    });

    // keys.json sends these here: Esc (herdr never passes it to a popup as a key), Tab and shift-Tab.
    cx.spawn(async (cx) => {
      // Guarded as a whole, so one handler that throws doesn't leave Esc and Tab dead for the rest of the popup.
      for (;;) {
        try {
          const c = await nextCommand();
          if (c === "escape") this.escape(cx);
          else if ((c === "tab" || c === "backtab") && this.screen === "list") this.step(c === "tab" ? 1 : -1, cx);
          else if ((c === "tab" || c === "backtab") && this.screen === "create") this.nextField(cx);
          else if ((c === "tab" || c === "backtab") && this.screen === "settings" && !this.menu) this.settingsField(c === "tab" ? 1 : -1, cx);
          cx.notify();
        } catch (e) {
          this.fail("command", e);
        }
      }
    });
  }

  /** Wraps a handler: an exception is logged and shown in the popup instead of vanishing. */
  guard(where, fn) {
    return (...a) => {
      try {
        const r = fn(...a);
        if (r && r.catch) r.catch((e) => this.fail(where, e));
        return r;
      } catch (e) {
        this.fail(where, e);
      }
    };
  }

  fail(where, e) {
    console.error(`[shortcut] ${where}: ${e?.message ?? e}`);
    this.err = `${where}: ${e?.message ?? e}`;
    this.cx.notify();
  }

  // ── loading ────────────────────────────────────────────────────────────

  // Settings, then what was kept from last time (drawn at once), then the token (the person's shell can be slow
  // to start), then fresh data.
  async boot(cx) {
    const s = await loadSettings();
    this.cfg = s.cfg;
    this.raw = s.raw;
    this.cfgError = s.error;
    this.cache = await readCache();
    for (const k of REF) if (this.cache[k]) this.ref[k] = this.cache[k];
    this.lists = { ...(this.cache.lists ?? {}) };
    cx.notify();
    this.github = (await readTextFile(`${appHome()}/mods/github/main.js`).catch(() => null)) != null;
    const { token, error } = await resolveToken(this.cfg);
    if (error || !token) {
      this.screen = "signIn";
      this.signInNote = error ?? `No API token: $${this.cfg.auth.env} is empty or unset in your login shell.`;
      return cx.notify();
    }
    this.client = createClient({ token });
    cx.notify();
    this.refreshAll(cx);
    if (this.openWith) {
      try {
        this.openStory(await this.client.story(Number(this.openWith)), cx, { refetch: false });
      } catch (e) {
        this.say(`sc-${this.openWith}: ${e?.message ?? e}`, cx, true);
      }
    }
  }

  get me() {
    return this.ref.member?.data ?? null;
  }

  // Reference data older than 10 minutes and the shown tab's list older than a minute (everything, when forced),
  // in one task; the cache is written once at the end.
  refreshAll(cx, { force = false } = {}) {
    if (!this.client || this.refreshing) return;
    this.refreshing = true;
    const tab = this.listId();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const k of REF) {
          if (!force && fresh(this.ref[k], REF_MAX)) continue;
          const data = await this.client[CALL[k]]();
          this.ref[k] = this.cache[k] = { at: Date.now(), data };
        }
        if (force || !fresh(this.lists[tab], LIST_MAX)) await this.load(tab, cx);
        this.err = "";
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          delete this.cache.member;
          delete this.ref.member;
          this.screen = "signIn";
          this.signInNote = "Shortcut refused the token (401): it may have been revoked.";
        } else {
          const shown = Boolean(this.lists[tab]?.data?.length);
          this.err = shown ? `offline, showing cached: ${e?.message ?? e}` : String(e?.message ?? e);
        }
      }
      await this.keep();
      this.refreshing = false;
      cx.notify();
    });
  }

  // The cache file, best effort: another popup may have written it since it was read.
  async keep() {
    try {
      await writeCache(this.cache);
    } catch {}
  }

  // The shown list's id: the tab's, or the drilled epic's ("epic:3").
  listId() {
    return this.tab === "epics" && this.drilled ? `epic:${this.drilled.id}` : this.tab;
  }

  // The team shown: the chosen group while I am still in it, else the first I am in, else none.
  teamId() {
    const mine = this.myGroups();
    return (mine.find((g) => g.id === this.group) ?? mine[0])?.id ?? null;
  }

  myGroups() {
    return (this.ref.groups?.data ?? []).filter((g) => (g.member_ids ?? []).includes(this.me?.id));
  }

  // A story fetched lately by any list, so Recent need not fetch it again.
  cachedStory(id) {
    for (const [name, l] of Object.entries(this.lists)) {
      if (name === "epics" || name === "recent" || !fresh(l, REF_MAX) || !Array.isArray(l.data)) continue;
      const s = l.data.find((x) => x.id === id && x.workflow_state_id != null);
      if (s) return s;
    }
    return null;
  }

  // One list (a tab's, or "epic:<id>"), into this.lists and the cache (not written: the caller keeps it).
  async load(tab, cx) {
    this.loading.add(tab);
    cx.notify();
    try {
      let list;
      if (tab === "mine") {
        const body = { owner_ids: [this.me.id], workflow_state_types: ["unstarted", "started"], archived: false };
        list = await this.client.searchStories(body, { pages: 10 });
      } else if (tab === "team") {
        const group = this.teamId();
        list = group == null ? { data: [], cut: false }
          : await this.client.searchStories({ group_ids: [group], workflow_state_types: ["started"], archived: false }, { pages: 4 });
      } else if (tab === "epics") {
        list = { data: await this.client.epics() };
      } else if (tab.startsWith("epic:")) {
        list = await this.client.searchStories({ epic_ids: [Number(tab.slice(5))], archived: false }, { pages: 4 });
      } else if (tab === "recent") {
        const data = [];
        for (const { id } of this.cfg.recent ?? []) {
          try {
            const s = this.cachedStory(id) ?? (await this.client.story(id));
            if (s) data.push(s);
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) throw e;
          }
        }
        list = { data };
      } else return;
      this.lists[tab] = (this.cache.lists ??= {})[tab] = { at: Date.now(), ...list };
    } finally {
      this.loading.delete(tab);
      cx.notify();
    }
  }

  // A story's key in the filter is fetched from the whole workspace; other text of 3 or more characters that
  // matches nothing here is searched for in the workspace once typing pauses (each change re-arms the wait).
  lookUp(cx) {
    const q = this.filter.trim();
    const seq = ++this.searchSeq;
    const m = STORY_KEY.exec(q);
    if (!m) this.found = null;
    else if (this.found && String(this.found.id) !== m[1]) this.found = null;
    if (!this.client) return;
    if (m) {
      cx.spawn(async (cx) => {
        try {
          const s = await this.client.story(Number(m[1]));
          if (STORY_KEY.exec(this.filter.trim())?.[1] === m[1]) this.found = s;
        } catch {}
        cx.notify();
      });
      return;
    }
    if (q.length < 3 || this.localRows().length) return;
    cx.timer.after(400, () => {
      if (seq !== this.searchSeq) return;
      this.cx.spawn(async (cx) => {
        try {
          const data = await this.client.textSearch(q);
          if (this.filter.trim() === q) this.searched = { query: q, data: data ?? [] };
        } catch (e) {
          if (this.filter.trim() === q) this.say(`Workspace search failed: ${e?.message ?? e}`, cx, true);
        }
        cx.notify();
      });
    });
  }

  // ── the rows ───────────────────────────────────────────────────────────

  workflowOf(story) {
    return (this.ref.workflows?.data ?? []).find((w) => w.id === story.workflow_id) ?? null;
  }

  stateOf(story) {
    const own = this.workflowOf(story)?.states?.find((s) => s.id === story.workflow_state_id);
    if (own) return own;
    for (const w of this.ref.workflows?.data ?? []) {
      const s = w.states?.find((x) => x.id === story.workflow_state_id);
      if (s) return s;
    }
    return null;
  }

  epicOf(story) {
    return story.epic_id == null ? null : (this.ref.epics?.data ?? []).find((e) => e.id === story.epic_id) ?? null;
  }

  iterationOf(story) {
    return story.iteration_id == null ? null : (this.ref.iterations?.data ?? []).find((i) => i.id === story.iteration_id) ?? null;
  }

  priorityOf(story) {
    const f = this.cfg.priorityField;
    return f ? (story.custom_fields ?? []).find((x) => x.field_id === f)?.value ?? null : null;
  }

  matches(story, f) {
    if (!f) return true;
    const hay = [`sc-${story.id}`, story.name, this.epicOf(story)?.name, ...(story.labels ?? []).map((l) => l.name)]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(f);
  }

  // The shown list's rows that pass the filter (not the looked-up story): epics on the Epics tab, else stories.
  localRows() {
    const f = this.filter.trim().toLowerCase();
    const data = this.lists[this.listId()]?.data ?? [];
    if (this.listId() === "epics") return data.filter((e) => !f || String(e.name ?? "").toLowerCase().includes(f));
    return data.filter((s) => this.matches(s, f));
  }

  // Stories under a heading per workflow state, in each workflow's state order.
  grouped(stories) {
    const order = new Map();
    for (const w of this.ref.workflows?.data ?? []) {
      [...(w.states ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).forEach((s) => order.set(s.id, { state: s, n: order.size }));
    }
    const groups = new Map();
    for (const s of stories) {
      const g = groups.get(s.workflow_state_id) ?? [];
      g.push(s);
      groups.set(s.workflow_state_id, g);
    }
    const rows = [];
    const ids = [...groups.keys()].sort((a, b) => (order.get(a)?.n ?? Infinity) - (order.get(b)?.n ?? Infinity));
    for (const id of ids) {
      const st = order.get(id)?.state;
      rows.push({ header: st?.name ?? "Other", type: st?.type ?? null });
      for (const story of groups.get(id)) rows.push({ story });
    }
    return rows;
  }

  // The rows shown: { header }, { story }, { epic } and { title }. The looked-up story comes first; the workspace's search results
  // come last, under their own heading, when nothing here matches.
  shownRows() {
    const q = this.filter.trim();
    const found = this.found && STORY_KEY.test(q) ? this.found : null;
    const local = this.localRows().filter((s) => s.id !== found?.id);
    const rows = found ? [{ story: found }] : [];
    if (this.listId() === "epics") rows.push(...local.map((epic) => ({ epic })));
    else if (this.tab === "recent") {
      if (local.length) rows.push({ header: "Recent", type: null }, ...local.map((story) => ({ story })));
    } else {
      if (this.drilled && this.tab === "epics") rows.push({ title: `Epic · ${this.drilled.name}` });
      rows.push(...this.grouped(local));
    }
    if (!local.length && this.searched?.query === q && this.searched.data.length) {
      rows.push({ header: "Workspace", type: null }, ...this.searched.data.map((story) => ({ story })));
    }
    return rows;
  }

  // The chosen row moves over stories only, skipping the headings.
  move(d) {
    const rows = this.shown ?? this.shownRows();
    for (let i = this.at + d; i >= 0 && i < rows.length; i += d) {
      if (rows[i].story || rows[i].epic) {
        this.at = i;
        return this.follow();
      }
    }
  }

  // Keeps the chosen row in sight: the first, with its heading.
  follow() {
    const rows = this.shown ?? [];
    const first = rows.findIndex((r) => r.story || r.epic);
    this.scroll.scroll_to_item(this.at === first ? 0 : this.at);
  }

  // The chosen row is always a story (or an epic): the first at or after it, else the last one.
  pickRow(rows) {
    const pickable = (r) => r.story || r.epic;
    if (pickable(rows[this.at] ?? {})) return;
    let i = rows.findIndex((r, j) => j >= this.at && pickable(r));
    for (let j = rows.length - 1; i < 0 && j >= 0; j--) if (pickable(rows[j])) i = j;
    this.at = Math.max(0, i);
  }

  selected() {
    return (this.shown ?? this.shownRows())[this.at]?.story ?? null;
  }

  selectedEpic() {
    return (this.shown ?? this.shownRows())[this.at]?.epic ?? null;
  }

  step(d, cx) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.pickTab(TABS[(i + d + TABS.length) % TABS.length].id, cx);
  }

  pickTab(id, cx) {
    this.tab = id;
    this.drilled = null;
    localStorage.setItem("tab", id);
    this.at = 0;
    this.refreshAll(cx);
    cx.notify();
  }

  enter(cx) {
    this.pickRow(this.shown ?? this.shownRows());
    const s = this.selected();
    if (s) return this.openStory(s, cx);
    const e = this.selectedEpic();
    if (e) this.drill(e, cx);
  }

  // The Epics tab lists an epic's stories (older than a minute, or not yet loaded: fetched).
  drill(epic, cx) {
    this.drilled = epic;
    this.at = 0;
    this.refreshAll(cx);
    cx.notify();
  }

  chooseGroup(id, cx) {
    this.group = id;
    localStorage.setItem("group", id);
    this.at = 0;
    this.refreshAll(cx, { force: true });
    cx.notify();
  }

  // ── the story ──────────────────────────────────────────────────────────

  // Its screen at once, from the copy the list has; then a fresh copy, which replaces it (and its row).
  openStory(story, cx, { refetch = true } = {}) {
    this.cur = story;
    this.screen = "story";
    this.menu = null;
    this.prAt = -1;
    this.err = this.flash = "";
    // The filter is not drawn here: the keyboard goes to the popup's own keys.
    this.focus.focus?.();
    cx.notify();
    if (!refetch || !this.client) return;
    cx.spawn(async (cx) => {
      try {
        const s = await this.client.story(story.id);
        if (this.screen === "story" && this.cur?.id === story.id) {
          this.replaceStory(s);
          await this.keep();
        }
      } catch (e) {
        if (story.workflow_state_id == null && this.cur?.id === story.id) this.err = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // A newer copy of a story: the shown one, and its row in the shown list (the cache holds the same list).
  replaceStory(s) {
    if (!s) return;
    if (this.cur?.id === s.id) this.cur = s;
    if (this.listId() === "epics") return;
    const l = this.lists[this.listId()];
    const i = Array.isArray(l?.data) ? l.data.findIndex((x) => x.id === s.id) : -1;
    if (i >= 0) l.data[i] = s;
  }

  // The branch a start would use: its open PR's, else its own, else the template's.
  branchOf(story) {
    return branchCandidates(story, this.cfg, storyVars(story, this.me)).candidates[0];
  }

  // The states of its workflow in their order, all of them (by hand a story may go anywhere), its own chosen.
  stateMenu(cx) {
    const s = this.cur;
    const states = [...(this.workflowOf(s)?.states ?? [])].sort(byPosition);
    if (!states.length) return this.say("Its workflow is not loaded yet.", cx, true);
    this.menu = { kind: "state", items: states.map((x) => ({ label: x.name, value: x.id })), at: Math.max(0, states.findIndex((x) => x.id === s.workflow_state_id)) };
    cx.notify();
  }

  // The configured priority field's values, its own chosen (else the first).
  priorityMenu(cx) {
    const s = this.cur;
    const f = this.cfg.priorityField;
    const field = (this.ref.customFields?.data ?? []).find((x) => x.id === f);
    const values = (field?.values ?? []).filter((x) => x.enabled !== false).sort(byPosition);
    if (!values.length) return this.say("The priority field is not loaded yet.", cx, true);
    const own = (s.custom_fields ?? []).find((x) => x.field_id === f)?.value_id;
    this.menu = { kind: "priority", items: values.map((x) => ({ label: x.value, value: x.id })), at: Math.max(0, values.findIndex((x) => x.id === own)) };
    cx.notify();
  }

  choose(item, cx) {
    const m = this.menu;
    this.menu = null;
    const s = this.cur;
    if (m?.kind === "pickState" && item && this.pick) {
      const p = this.pick;
      this.pick = null;
      this.screen = p.from;
      p.resume(item.value, cx);
    } else if (m?.kind === "branch" && item && this.branching) {
      const b = this.branching;
      this.branching = null;
      b.resume(item.value, cx);
    } else if (m?.kind === "startState" && item) {
      if (item.value == null) delete this.cfg.startStates[String(m.wf)];
      else this.cfg.startStates[String(m.wf)] = item.value;
      this.scheduleSave(cx);
    } else if (m?.kind === "cfgPriority" && item) {
      this.cfg.priorityField = item.value;
      this.scheduleSave(cx);
    } else if (m?.kind === "launcher" && item) {
      this.cfg.launcher = item.value;
      this.scheduleSave(cx);
    } else if (m && item && s) {
      if (m.kind === "state" && item.value !== s.workflow_state_id) this.update(s, { workflow_state_id: item.value }, `Moved sc-${s.id} to ${item.label}`, cx);
      else if (m.kind === "priority") this.update(s, { custom_fields: this.withPriority(s, item.value) }, `sc-${s.id}'s priority: ${item.label}`, cx);
    }
    cx.notify();
  }

  // custom_fields is the story's whole list: its other fields go along, the priority's replaced in place (or appended).
  withPriority(story, valueId) {
    const f = this.cfg.priorityField;
    const out = (story.custom_fields ?? []).map(({ field_id, value_id }) => ({ field_id, value_id }));
    const i = out.findIndex((x) => x.field_id === f);
    if (i >= 0) out[i] = { field_id: f, value_id: valueId };
    else out.push({ field_id: f, value_id: valueId });
    return out;
  }

  // One change at a time: another while one is on its way is ignored.
  update(story, patch, done, cx) {
    if (this.busy) return;
    this.busy = `Updating sc-${story.id}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const s = await this.client.updateStory(story.id, patch);
        this.busy = "";
        this.replaceStory(s);
        this.say(done, cx);
        await this.keep();
      } catch (e) {
        this.busy = "";
        if (e instanceof ApiError) this.say(e.message, cx, true);
        else this.fail("update", e);
      }
    });
  }

  // A pull request on its screen in the github mod (Esc there comes back to this story), else in the browser.
  openPR(pr, cx) {
    const m = PR_URL.exec(pr.url ?? "");
    if (!this.github || !m) return this.open(pr.url, cx);
    const id = this.cur.id;
    this.dismiss();
    openOverlay({ mod: "github", kind: "dialog", width: 0.8, height: 0.8, props: {
      pr: { host: m[1], repo: m[2], number: pr.number ?? Number(m[3]) },
      backTo: { mod: "shortcut", label: `sc-${id}`, props: { screen: "story", id } },
    } });
  }

  // Out of the story: to the mod that opened it on this story (or closed, when none said where), else to its row.
  back(cx) {
    if (this.openWith) {
      this.dismiss();
      if (this.backTo) openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} });
      return;
    }
    const id = this.cur?.id;
    this.screen = "list";
    this.menu = null;
    this.prAt = -1;
    this.err = this.flash = "";
    const i = this.shownRows().findIndex((r) => r.story?.id === id);
    if (i >= 0) this.at = i;
    cx.timer.after(30, () => this.screen === "list" && this.input.focus());
    cx.notify();
  }

  // ── starting a story (spec 8.1) ────────────────────────────────────────
  // The rules live in start.js and launch.js; this runs them in order. A start pauses on pickState or the branch
  // menu (its task ends there) and goes on in a new task when one is chosen; Esc on either cancels it.

  startStory(story, cx) {
    if (!story || !this.client || this.busy || this.pick || this.branching) return;
    this.startTask(story.id, cx, async (cx) => {
      const fresh = await this.client.story(story.id);
      // The launcher must be able to take it before the ticket is touched (spec 7: the finder's work happens first,
      // but a start the launcher would refuse for its configuration does not start at all).
      const ready = await launcherReady({ cfg: this.cfg, space: this.activeSpace(), panes: panes(), exec, readTextFile });
      if (ready.error) return this.say(ready.error, cx, true);
      await this.decide(fresh, cx);
    });
  }

  activeSpace() {
    return spaces().find((s) => s.active) ?? null;
  }

  // One stage of a start in its own task, with the busy line while it runs; whatever it throws is shown.
  startTask(id, cx, stage) {
    this.busy = `Starting sc-${id}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await stage(cx);
        this.busy = "";
      } catch (e) {
        this.busy = "";
        this.say(String(e?.message ?? e), cx, true);
      }
      cx.notify();
    });
  }

  // Steps 3 to 5: refused, ask for the workflow's start state, or update the story; then the branch.
  async decide(story, cx) {
    const workflow = this.workflowOf(story);
    if (!workflow) return this.say(`sc-${story.id}: its workflow is not loaded yet.`, cx, true);
    const d = startDecision({ story, workflow, me: this.me, cfg: this.cfg, iterations: this.ref.iterations?.data ?? [] });
    if (d.refused) return this.say(d.refused, cx, true);
    if (d.askState) {
      if (d.dropStale) {
        delete this.cfg.startStates[String(workflow.id)];
        this.raw = await saveSettings(this.cfg, this.raw);
      }
      return this.askStartState(story, workflow, cx);
    }
    if (d.patch) {
      try {
        story = await this.client.updateStory(story.id, d.patch);
      } catch (e) {
        if (e instanceof ApiError) return this.say(e.message, cx, true);
        throw e;
      }
      this.replaceStory(story);
      await this.keep();
    }
    return this.chooseBranch(story, d.notes, cx);
  }

  // pickState: the workflow's unstarted and started states, the first started one highlighted; the one chosen is kept
  // and the start goes on from step 3.
  askStartState(story, workflow, cx) {
    const states = startable(workflow);
    if (!states.length) return this.say(`${workflow.name} has no state to start in`, cx, true);
    this.pick = {
      story, workflow, from: this.screen,
      resume: (stateId, cx) => this.startTask(story.id, cx, async (cx) => {
        this.cfg.startStates[String(workflow.id)] = stateId;
        this.raw = await saveSettings(this.cfg, this.raw);
        await this.decide(story, cx);
      }),
    };
    this.screen = "pickState";
    this.menu = { kind: "pickState", items: states.map((x) => ({ label: x.name, value: x.id })), at: Math.max(0, states.findIndex((x) => x.type === "started")) };
    this.focus.focus?.();
    cx.notify();
  }

  // Step 6: one candidate goes straight on; several are asked about in the branch menu.
  chooseBranch(story, notes, cx) {
    const { candidates, checkout } = branchCandidates(story, this.cfg, storyVars(story, this.me));
    if (candidates.length === 1) return this.launch(story, candidates[0], checkout, notes, cx);
    this.branching = { story, resume: (branch, cx) => this.startTask(story.id, cx, (cx) => this.launch(story, branch, checkout, notes, cx)) };
    this.menu = { kind: "branch", items: candidates.map((c) => ({ label: c, value: c })), at: 0 };
    this.focus.focus?.();
    cx.notify();
  }

  // Steps 6 (the prompt) to 8: a valid branch, recent, the launcher, then the popup closes.
  async launch(story, branch, checkout, notes, cx) {
    const ok = await exec("git", ["check-ref-format", "--branch", branch]);
    if (ok.code !== 0) return this.say(`"${branch}" is not a valid branch name: check the branch template in settings`, cx, true);
    const prompt = expand(this.cfg.startPrompt, storyVars(story, this.me, branch));
    this.cfg.recent = [{ id: story.id, at: new Date().toISOString() }, ...(this.cfg.recent ?? []).filter((r) => r.id !== story.id)].slice(0, 30);
    this.raw = await saveSettings(this.cfg, this.raw);
    const r = await openLauncher({
      cfg: this.cfg,
      launch: buildLaunchRequest({ story, branch, checkout, prompt, hints: repoHints(story) }),
      back: backTo(story),
      space: this.activeSpace(),
      panes: panes(),
      exec, openOverlay, readTextFile,
    });
    if (r.error) return this.say(r.error, cx, true);
    // Anything said (the start's notes, the launcher's note) is shown for 1.5 s before the popup closes.
    const said = [...notes, r.note].filter(Boolean).join(" · ");
    if (!said) return this.dismiss();
    this.say(said, cx);
    this.cx.timer.after(1500, () => this.dismiss());
  }

  // Esc on pickState or the branch menu: the start stops there, nothing more is written.
  cancelStart(cx) {
    if (this.pick) this.screen = this.pick.from;
    this.menu = this.pick = this.branching = null;
    this.say("Start cancelled", cx);
  }

  // ── actions (the screens they lead to come in later tasks) ─────────────

  // ── a new story ────────────────────────────────────────────────────────
  // A name and description, then chips for the team, state, type, epic, iteration, owner and (when configured)
  // priority. Ctrl+Enter creates it and opens it; Esc goes back to the screen it came from.

  create(cx) {
    if (!this.client || !this.me) return;
    const groups = this.ref.groups?.data ?? [];
    const group = this.myGroups()[0] ?? groups[0] ?? null;
    this.from = this.screen === "story" ? "story" : "list";
    this.form = { name: "", desc: "", group, state: this.firstState(group), type: "feature", epic: null, iteration: null, mine: true, priority: null };
    this.screen = "create";
    this.menu = null;
    this.err = this.flash = "";
    this.title = InputState.new({ placeholder: "Story name" });
    this.desc = TextareaState.new({ placeholder: "Description (optional)", rows: 4 });
    this.onDesc = false;
    this.title.on("submit", () => {
      this.onDesc = true;
      this.desc.focus();
    });
    this.title.focus();
    cx.notify();
  }

  // The workflow a team's stories go in: its first, else the first there is.
  workflowFor(group) {
    const all = this.ref.workflows?.data ?? [];
    return all.find((w) => w.id === group?.workflow_ids?.[0]) ?? all[0] ?? null;
  }

  // The state a new story starts in: the workflow's first unstarted one (by position), else its first.
  firstState(group) {
    const states = [...(this.workflowFor(group)?.states ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return (states.find((s) => s.type === "unstarted") ?? states[0])?.id ?? null;
  }

  pickTeam(group, cx) {
    const f = this.form;
    f.group = group;
    f.state = this.firstState(group);
    // An iteration belongs to teams; the one chosen may not be this team's.
    if (f.iteration != null && !this.iterationsFor(group).some((i) => i.id === f.iteration)) f.iteration = null;
    cx.notify();
  }

  iterationsFor(group) {
    return (this.ref.iterations?.data ?? []).filter((i) => (i.status === "started" || i.status === "unstarted")
      && (!i.group_ids?.length || !group || i.group_ids.includes(group.id)));
  }

  // Tab and Shift-Tab: between the name and the description.
  nextField(cx) {
    this.onDesc = !this.onDesc;
    (this.onDesc ? this.desc : this.title).focus();
    cx.notify();
  }

  submit(cx) {
    const f = this.form;
    if (!f || this.busy || !this.client) return;
    const name = this.title.value().trim();
    if (!name) return this.say("A name is required", cx, true);
    const params = {
      name,
      description: this.desc.value(),
      story_type: f.type,
      owner_ids: f.mine ? [this.me.id] : [],
    };
    if (f.group) params.group_id = f.group.id;
    if (f.state != null) params.workflow_state_id = f.state;
    if (f.epic != null) params.epic_id = f.epic;
    if (f.iteration != null) params.iteration_id = f.iteration;
    if (this.cfg.priorityField && f.priority != null) params.custom_fields = [{ field_id: this.cfg.priorityField, value_id: f.priority }];
    this.err = this.flash = "";
    this.busy = "Creating…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const created = await this.client.createStory(params);
        this.busy = "";
        const mine = this.lists.mine;
        if (f.mine && mine?.data) mine.data = [created, ...mine.data.filter((x) => x.id !== created.id)];
        this.openStory(created, cx);
        this.flash = `Created sc-${created.id}. Press s to start it.`;
      } catch (e) {
        this.busy = "";
        if (!(e instanceof ApiError)) return this.fail("create", e);
        this.say(e.message, cx, true);
      }
      cx.notify();
    });
  }

  createKey(k, cx) {
    if (k === "ctrl-enter") this.submit(cx);
    else if (k === "tab" || k === "shift-tab") this.nextField(cx);
    else return false;
    return true;
  }

  // Esc: to the list or the story it was opened from.
  leaveCreate(cx) {
    this.screen = this.from === "story" && this.cur ? "story" : "list";
    this.err = this.flash = "";
    this.focus.focus?.();
    cx.notify();
  }

  // ── settings ───────────────────────────────────────────────────────────
  // Rows edited in place; every change is saved 300 ms after the last one. A pasted token stays in its box until it
  // is saved, then only "••••" and its last four characters are drawn. The token is never said, logged or cached.

  openSettings(cx) {
    if (this.screen === "settings") return;
    this.from = this.screen === "story" || this.screen === "signIn" ? this.screen : "list";
    this.screen = "settings";
    this.menu = null;
    this.err = this.flash = "";
    this.authMode = this.cfg.auth.token ? "token" : "env";
    this.authDirty = false;
    this.setAt = 0;
    // Each box is filled before its change handler is set, so filling it is not a change.
    this.envInput = InputState.new({ placeholder: "SHORTCUT_API_TOKEN" });
    this.envInput.set_value(this.cfg.auth.env ?? DEFAULTS.auth.env);
    // Only a valid name is kept and saved: anything else (a token pasted here, say) is neither saved nor echoed.
    this.envInput.on("change", () => {
      const name = this.envInput.value().trim();
      if (!ENV_NAME.test(name)) return this.say("Not a valid environment variable name", this.cx, true);
      this.cfg.auth = { env: name };
      this.authDirty = true;
      this.scheduleSave(this.cx);
    });
    this.envInput.on("submit", () => this.saveNow());
    this.tokenInput = InputState.new({ placeholder: "Paste a token" });
    this.tokenInput.on("change", () => {
      const v = this.tokenInput.value().trim();
      if (!v) return;
      this.authMode = "token";
      this.cfg.auth = { token: v };
      this.authDirty = true;
      this.scheduleSave(this.cx);
    });
    this.promptBox = TextareaState.new({ rows: 3 });
    this.promptBox.set_value(this.cfg.startPrompt);
    this.promptBox.on("change", () => {
      this.cfg.startPrompt = this.promptBox.value();
      this.scheduleSave(this.cx);
    });
    this.branchInput = InputState.new({ placeholder: DEFAULTS.branchTemplate });
    this.branchInput.set_value(this.cfg.branchTemplate);
    this.branchInput.on("change", () => {
      this.cfg.branchTemplate = this.branchInput.value();
      this.scheduleSave(this.cx);
    });
    this.focus.focus?.();
    cx.notify();
  }

  // The text boxes Tab moves between: the shown auth box, the prompt and the branch template.
  settingInputs() {
    const auth = this.authMode === "env" ? this.envInput : this.cfg.auth.token && !this.tokenInput.value() ? null : this.tokenInput;
    return [auth, this.promptBox, this.branchInput].filter(Boolean);
  }

  settingsField(d, cx) {
    const all = this.settingInputs();
    this.setAt = (this.setAt + d + all.length) % all.length;
    all[this.setAt].focus();
    cx.notify();
  }

  settingsKey(k, cx) {
    if (this.menu) return this.menuKey(k, cx);
    if (k === "tab" || k === "shift-tab") this.settingsField(k === "tab" ? 1 : -1, cx);
    else return false;
    return true;
  }

  // The radio: "Environment variable" drops a pasted token; "Token" shows the paste box (saved once pasted).
  pickAuth(mode, cx) {
    if (mode === this.authMode) return;
    this.authMode = mode;
    if (mode === "env") {
      const name = this.envInput.value().trim();
      this.cfg.auth = { env: ENV_NAME.test(name) ? name : DEFAULTS.auth.env };
      this.authDirty = true;
      this.scheduleSave(cx);
    }
    cx.notify();
  }

  clearToken(cx) {
    this.cfg.auth = { env: DEFAULTS.auth.env };
    this.tokenInput.set_value("");
    this.authDirty = true;
    this.scheduleSave(cx);
  }

  // GET /member with the token as configured now; on success the popup uses that client from here on.
  testToken(cx) {
    cx.spawn(async (cx) => {
      try {
        const { token, error } = await resolveToken(this.cfg);
        if (error || !token) return this.say(error ?? `No API token: $${this.cfg.auth.env} is empty or unset in your login shell.`, cx, true);
        const client = createClient({ token });
        const me = await client.me();
        this.client = client;
        this.authDirty = false;
        this.ref.member = { at: Date.now(), data: me };
        this.say(`Signed in as ${me?.name ?? me?.mention_name ?? "?"}`, cx);
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  // A workflow's start state: the placeholder (unset) and its unstarted and started states.
  openStateMenu(wfId, cx) {
    const wf = (this.ref.workflows?.data ?? []).find((w) => w.id === wfId);
    if (!wf) return;
    const states = startable(wf);
    const items = [{ label: "Please select a start state", value: null }, ...states.map((x) => ({ label: x.name, value: x.id }))];
    const cur = this.cfg.startStates[String(wfId)];
    this.menu = { kind: "startState", wf: wfId, items, at: Math.max(0, items.findIndex((i) => i.value != null && i.value === cur)) };
    cx.notify();
  }

  // Enabled custom fields with at least one value, after "None".
  openPriorityMenu(cx) {
    const fields = (this.ref.customFields?.data ?? []).filter((f) => f.enabled !== false && (f.values ?? []).length > 0);
    const items = [{ label: "None", value: null }, ...fields.map((f) => ({ label: f.name, value: f.id }))];
    this.menu = { kind: "cfgPriority", items, at: Math.max(0, items.findIndex((i) => i.value === this.cfg.priorityField)) };
    cx.notify();
  }

  // The shipped dialog, then each folder under mods/ that has a main.js (and the chosen mod, when it is not there).
  openLauncherMenu(cx) {
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/mods`;
      const names = [];
      try {
        const r = await exec("ls", [dir]);
        if (r.code === 0) {
          for (const n of String(r.stdout ?? "").split("\n").map((x) => x.trim()).filter(Boolean)) {
            if ((await readTextFile(`${dir}/${n}/main.js`).catch(() => null)) != null) names.push(n);
          }
        }
      } catch {}
      names.sort();
      const cur = this.cfg.launcher;
      if (cur.kind === "mod" && !names.includes(cur.name)) names.push(cur.name);
      const items = [{ label: "Shipped worktree dialog", value: { kind: "shipped" } }, ...names.map((n) => ({ label: `Mod: ${n}`, value: { kind: "mod", name: n } }))];
      const at = items.findIndex((i) => i.value.kind === cur.kind && i.value.name === cur.name);
      this.menu = { kind: "launcher", items, at: Math.max(0, at) };
      cx.notify();
    });
  }

  // Only the last change in 300 ms is saved.
  scheduleSave(cx) {
    const seq = ++this.saveSeq;
    this.cx.timer.after(300, () => seq === this.saveSeq && this.cx.spawn(() => this.saveNow()));
    cx.notify();
  }

  // Saves run one after another (each writes against the text the last one wrote).
  saveNow() {
    this.saveSeq++;
    this.saving = (this.saving ?? Promise.resolve()).then(async () => {
      try {
        this.cfg = normalize(this.cfg);
        this.raw = await saveSettings(this.cfg, this.raw);
        if (this.cfg.auth.token && this.tokenInput?.value()) this.tokenInput.set_value("");
        this.say("Saved", this.cx);
      } catch (e) {
        this.say(String(e?.message ?? e), this.cx, true);
      }
    });
    return this.saving;
  }

  // Esc: back where it was opened from. A changed token (or none yet) is looked up again and the data refreshed.
  leaveSettings(cx) {
    this.menu = null;
    this.err = this.flash = "";
    this.focus.focus?.();
    if (this.client && !this.authDirty) {
      if (this.from === "signIn") {
        this.screen = "list";
        this.refreshAll(cx);
      } else this.screen = this.from === "story" && this.cur ? "story" : "list";
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        await this.saving;
        const { token, error } = await resolveToken(this.cfg);
        this.authDirty = false;
        if (error || !token) {
          this.client = null;
          this.screen = "signIn";
          this.signInNote = error ?? `No API token: $${this.cfg.auth.env} is empty or unset in your login shell.`;
          return cx.notify();
        }
        this.client = createClient({ token });
        this.screen = this.from === "story" && this.cur ? "story" : "list";
        this.refreshAll(cx, { force: true });
      } catch (e) {
        this.fail("settings", e);
      }
      cx.notify();
    });
  }

  // One row: its label, its value (elements), and a hint under the value.
  settingRow(o, label, value, hint) {
    return h_flex().flex_none().gap(12).items_start().py(4)
      .child(div().flex_none().w(110).pt(4).text_size(12).font_medium().text_color(o.muted).child(label))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .children([value].flat().filter(Boolean))
        .when(Boolean(hint), (el) => el.child(div().text_size(11.5).text_color(o.dim).line_height(1.4).child(hint))));
  }

  settingsView(o) {
    const c = this.cfg;
    const box = (el) => div().flex_none().px(10).py(6).rounded(8).border_1().border_color(o.line).bg(o.sunk).child(el);
    const lit = (on) => (on ? o.accent : null);
    const pick = (id, label, on, fn) => chip(o, id, [label], { color: lit(on), click: this.guard(id, (cx) => fn(cx)) });
    const row = (...kids) => h_flex().flex_none().gap(6).items_center().flex_wrap().children(kids.filter(Boolean));
    const token = c.auth.token ? String(c.auth.token) : "";
    const masked = token && !this.tokenInput.value();
    const authValue = [
      row(pick("au-env", "Environment variable", this.authMode === "env", (cx) => this.pickAuth("env", cx)),
        pick("au-tok", "Token", this.authMode === "token", (cx) => this.pickAuth("token", cx)),
        chip(o, "au-test", ["Test"], { click: this.guard("test", (cx) => this.testToken(cx)) })),
      this.authMode === "env" ? box(Input.new(this.envInput).w_full().font_family(MONO).text_size(12.5).text_color(o.fg))
        : masked ? row(div().font_family(MONO).text_size(12.5).text_color(o.fg).child(token.length > 4 ? `••••${token.slice(-4)}` : "••••"),
          chip(o, "au-clear", ["Clear"], { click: this.guard("clear", (cx) => this.clearToken(cx)) }))
        : box(Input.new(this.tokenInput).w_full().font_family(MONO).text_size(12.5).text_color(o.fg)),
    ];
    const authHint = this.authMode === "env" ? "Read from your login shell when the popup opens."
      : "Kept in data/shortcut.json, readable only by you.";
    const preview = expand(c.branchTemplate, storyVars({ id: 1234, name: "Sample story", app_url: "" }, this.me));
    const workflows = this.ref.workflows?.data ?? [];
    const stateRows = workflows.map((w) => {
      const st = (w.states ?? []).find((x) => x.id === c.startStates[String(w.id)]);
      return row(div().flex_none().w(140).truncate().text_size(12.5).text_color(o.fg).child(w.name ?? `Workflow ${w.id}`),
        chip(o, `ss-${w.id}`, [st ? st.name : "Please select a start state"], { color: st ? null : o.fix, click: this.guard("start state", (cx) => this.openStateMenu(w.id, cx)) }));
    });
    const field = (this.ref.customFields?.data ?? []).find((f) => f.id === c.priorityField);
    const launcher = c.launcher.kind === "mod" ? `Mod: ${c.launcher.name}` : "Shipped worktree dialog";
    return v_flex().id("settings").flex_1().min_h(0).overflow_y_scrollbar().gap(6).pr(6)
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("Settings"))
      .when(Boolean(this.cfgError), (el) => el.child(div().text_size(12.5).text_color(o.fix).child(this.cfgError)))
      .child(this.settingRow(o, "Auth", authValue, authHint))
      .child(this.settingRow(o, "Start prompt", box(Textarea.new(this.promptBox).w_full().text_size(12.5).text_color(o.fg)),
        "{id} {number} {slug} {title} {url} {mention} {branch}"))
      .child(this.settingRow(o, "Branch name", [box(Input.new(this.branchInput).w_full().font_family(MONO).text_size(12.5).text_color(o.fg)),
        row(div().text_size(11.5).text_color(o.dim).child("Preview:"), div().font_family(MONO).text_size(12).text_color(o.fg).child(preview))],
        "{id} {number} {slug} {title} {url} {mention}"))
      .child(this.settingRow(o, "Start states", stateRows.length ? stateRows : div().text_size(12.5).text_color(o.dim).child("Workflows are not loaded yet."),
        "The state a story moves to when you start it, per workflow."))
      .child(this.settingRow(o, "Iteration", row(
        pick("it-cur", "Set to the current iteration if the story has none", c.iteration === "current-if-unset", (cx) => this.setOption("iteration", "current-if-unset", cx)),
        pick("it-never", "Never touch the iteration", c.iteration === "never", (cx) => this.setOption("iteration", "never", cx))), null))
      .child(this.settingRow(o, "Priority field", chip(o, "prio", [field ? field.name : "None"], { click: this.guard("priority", (cx) => this.openPriorityMenu(cx)) }),
        "Its values show on the rows, and p sets them on a story."))
      .child(this.settingRow(o, "Launcher", chip(o, "launcher", [launcher], { click: this.guard("launcher", (cx) => this.openLauncherMenu(cx)) }),
        "What opens the worktree when a story starts."));
  }

  setOption(key, value, cx) {
    this.cfg[key] = value;
    this.scheduleSave(cx);
  }

  open(url, cx) {
    if (url) cx.open_url(url);
  }

  copy(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.say(`Copied ${text}`, cx);
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  // On the list: a filter is cleared first (wherever the keyboard is), an empty one closes the popup.
  escape(cx) {
    if (this.menu?.kind === "pickState" || this.menu?.kind === "branch") return this.cancelStart(cx);
    if (this.menu) {
      this.menu = null;
      return cx.notify();
    }
    if (this.screen === "story") return this.back(cx);
    if (this.screen === "create") return this.leaveCreate(cx);
    if (this.screen === "settings") return this.leaveSettings(cx);
    if (this.screen === "list" && this.drilled) {
      this.drilled = null;
      this.at = 0;
      return cx.notify();
    }
    if (this.screen === "list" && this.filter) {
      this.input.set_value("");
      this.filter = "";
      this.found = this.searched = null;
      this.at = 0;
      return cx.notify();
    }
    if (this.screen === "list" || this.screen === "signIn") return this.dismiss();
    this.screen = "list";
    this.err = this.flash = "";
    cx.notify();
  }

  dismiss() {
    closeOverlay(props()?.overlay);
  }

  // ── keys ───────────────────────────────────────────────────────────────

  keys(e, cx) {
    const k = chord(e);
    let handled = true;
    if (k === "escape") this.escape(cx);
    else if (this.menu && (this.screen === "list" || this.screen === "pickState")) handled = this.menuKey(k, cx);
    else if (this.screen === "list") handled = this.listKey(k, cx);
    else if (this.screen === "story") handled = this.storyKey(k, cx);
    else if (this.screen === "signIn") handled = this.signInKey(k, cx);
    else if (this.screen === "create") handled = this.createKey(k, cx);
    else if (this.screen === "settings") handled = this.settingsKey(k, cx);
    else handled = false;
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  // Arrows always move; letters act only when the filter doesn't have the keyboard.
  listKey(k, cx) {
    // The highlighted row as drawn: before the first draw it may still be a heading.
    this.pickRow(this.shown ?? this.shownRows());
    const s = this.selected();
    if (k === "down") this.move(1);
    else if (k === "up") this.move(-1);
    else if (k === "pagedown") for (let i = 0; i < 12; i++) this.move(1);
    else if (k === "pageup") for (let i = 0; i < 12; i++) this.move(-1);
    else if (k === "left") this.step(-1, cx);
    else if (k === "right") this.step(1, cx);
    else if (this.typing) return false;
    else if (/^[1-4]$/.test(k)) this.pickTab(TABS[Number(k) - 1].id, cx);
    else if (k === "enter") this.enter(cx);
    else if (k === "r") this.refreshAll(cx, { force: true });
    else if (k === "/") this.input.focus();
    else if (k === "o" && s) this.open(s.app_url, cx);
    else if (k === "s" && s) this.startStory(s, cx);
    else if (k === "n") this.create(cx);
    else if (k === ",") this.openSettings(cx);
    else return false;
    return true;
  }

  // ↑ ↓ move over its pull requests; Enter opens the highlighted one.
  storyKey(k, cx) {
    if (this.menu) return this.menuKey(k, cx);
    const s = this.cur;
    const pr = (s.pull_requests ?? [])[this.prAt];
    if (k === "down") this.prAt = Math.min(this.prAt + 1, (s.pull_requests ?? []).length - 1);
    else if (k === "up") this.prAt = Math.max(this.prAt - 1, -1);
    else if (k === "enter" && pr) this.open(pr.url, cx);
    else if (k === "s") this.startStory(s, cx);
    else if (k === "t") this.stateMenu(cx);
    else if (k === "p" && this.cfg.priorityField) this.priorityMenu(cx);
    else if (k === "o") this.open(s.app_url, cx);
    else if (k === "y") this.copy(`sc-${s.id}`, cx);
    else if (k === "b") this.copy(this.branchOf(s), cx);
    else if (k === "g" && pr) this.openPR(pr, cx);
    else return false;
    return true;
  }

  menuKey(k, cx) {
    const m = this.menu;
    const n = m.items.length;
    if (k === "down") m.at = (m.at + 1) % n;
    else if (k === "up") m.at = (m.at + n - 1) % n;
    else if (k === "enter") this.choose(m.items[m.at], cx);
    else if (/^[1-9]$/.test(k) && Number(k) <= n) this.choose(m.items[Number(k) - 1], cx);
    else return false;
    return true;
  }

  signInKey(k, cx) {
    if (k !== ",") return false;
    this.openSettings(cx);
    return true;
  }

  // ── drawing: the list ──────────────────────────────────────────────────

  // A story's row, one line: its state icon in the state's colour, key and name; then its epic, iteration,
  // labels, pull requests and priority as chips. The chosen one lifts, with an edge in its state's colour.
  storyCard(o, s, on) {
    const st = this.stateOf(s);
    const color = stateColor(o, st?.type);
    const prs = (s.pull_requests ?? []).length;
    const prio = this.priorityOf(s);
    const chips = [
      this.epicOf(s) && chip(o, `ep-${s.id}`, [this.epicOf(s).name]),
      this.iterationOf(s) && chip(o, `it-${s.id}`, [this.iterationOf(s).name]),
      ...(s.labels ?? []).map((l, i) => chip(o, `lb-${s.id}-${i}`, [l.name])),
      prs > 0 && h_flex().flex_none().gap(4).items_center().child(icon("pr", o.dim, 12)).child(countPill(o, prs, on)),
      prio && chip(o, `pr-${s.id}`, [prio]),
      s.archived && chip(o, `ar-${s.id}`, ["archived"]),
    ].filter(Boolean);
    return h_flex()
      .id(`st-${s.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(o.raised).shadow_sm())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .when(Boolean(s.archived), (el) => el.opacity(0.55))
      .child(div().flex_none().w(3).h(16).rounded(2).when(on, (el) => el.bg(color)))
      .child(icon(stateIcon(st?.type), color, 14))
      .child(div().flex_none().w(64).font_family(MONO).text_size(11.5).text_color(o.muted).truncate().child(`sc-${s.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(s.archived ? o.dim : o.fg).child(s.name ?? ""))
      .child(h_flex().flex_none().gap(6).items_center().overflow_hidden().children(chips));
  }

  // An epic's row: its name, and how many of its stories are not done (when the epic says).
  epicCard(o, e, on) {
    const open = e.stats ? (e.stats.num_stories_unstarted ?? 0) + (e.stats.num_stories_started ?? 0) : null;
    return h_flex()
      .id(`ep-${e.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(o.raised).shadow_sm())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .child(icon("branch", on ? o.accent : o.dim, 14))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(o.fg).child(e.name ?? ""))
      .when(open !== null, (el) => el.child(countPill(o, open, on)));
  }

  // On the Team tab, when I am in several groups: a chip per group, the chosen one lit.
  groupChooser(o) {
    const mine = this.myGroups();
    if (this.tab !== "team" || mine.length < 2) return null;
    const chosen = this.teamId();
    return h_flex().flex_none().gap(6).items_center().flex_wrap().children(mine.map((g) =>
      chip(o, `grp-${g.id}`, [g.name], { color: g.id === chosen ? o.accent : null, click: this.guard("group", (cx) => this.chooseGroup(g.id, cx)) })));
  }

  heading(o, label, color, n) {
    return h_flex().flex_none().h(HEADING_H).px(10).pt(8).gap(8).items_center().text_size(11.5)
      .child(div().font_semibold().text_color(color ?? o.dim).child(label))
      .child(div().font_medium().text_color(o.dim).child(String(n)))
      .child(div().flex_1().h(1).bg(o.line));
  }

  tabBar(t, o) {
    return h_flex().flex_none().gap(4).items_center().children(TABS.map((tb) => {
      const on = tb.id === this.tab;
      const l = this.lists[tb.id];
      return h_flex().id(`tab-${tb.id}`).flex_none().h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
        .when(on, (el) => el.bg(o.raised).shadow_sm())
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pickTab(tb.id, cx))
        // Its icon, the spinner in its place while it loads: the same size, so the tabs never move.
        .child(this.loading.has(tb.id) ? icon("work", o.accent, 12).spin(1100) : icon(tb.icon, on ? o.fg : o.dim, 12))
        .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(tb.label))
        .child(countPill(o, l ? l.data.length : null, on));
    }));
  }

  note(o, text, color) {
    return div().px(14).py(10).text_size(12.8).text_color(color ?? o.dim).child(text);
  }

  listView(o) {
    const rows = this.shown;
    const l = this.lists[this.listId()];
    const notes = [];
    if (!rows.some((r) => r.story || r.epic) && !this.err) {
      notes.push(this.note(o, this.tab === "team" && l && this.teamId() == null ? "You are in no team."
        : !l ? "Loading…"
        : this.filter ? "Nothing matches. A story's key (sc-1234, #1234 or 1234) looks in the whole workspace."
        : this.tab === "mine" ? "No unstarted or started stories of yours." : "Nothing here yet."));
    }
    const entries = rows.map((r, i) => {
      if (r.title) return { key: `t-${i}`, h: HEADING_H, el: () => this.heading(o, r.title, o.fg, rows.slice(i + 1).filter((x) => x.story).length) };
      if (r.header) {
        let n = 0;
        for (let j = i + 1; j < rows.length && rows[j].story; j++) n++;
        return { key: `h-${i}-${r.header}`, h: HEADING_H, el: () => this.heading(o, r.header, r.type ? stateColor(o, r.type) : null, n) };
      }
      if (r.epic) return { key: `e-${i}-${r.epic.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(this.epicCard(o, r.epic, i === this.at)) };
      return { key: `r-${i}-${r.story.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(this.storyCard(o, r.story, i === this.at)) };
    });
    const more = l?.cut ? div().px(14).py(6).text_size(11.5).text_color(o.dim).child(`more… only the first ${l.data.length} are shown; the filter narrows them.`) : null;
    const chooser = this.groupChooser(o);
    return v_flex().flex_1().min_h(0).gap(2)
      .when(Boolean(chooser), (el) => el.child(chooser))
      .children(notes)
      .when(entries.length > 0, (el) => el.child(
        div().relative().h(Math.min(LIST_H, entries.reduce((h, e) => h + e.h, 0))).min_h(0).flex_shrink(1)
          .child(v_virtual_list("sc-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
            (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
            // A click chooses a row; on the chosen one, opens it.
            .on_item_click(this.guard("row click", (key, cx) => {
              const e = entries.find((x) => x.key === key);
              if (e?.row == null) return;
              if (e.row === this.at) return this.enter(cx);
              this.at = e.row;
              cx.notify();
            })))
          .child(Scrollbar.vertical("sc-rows").absolute().inset_0())))
      .when(Boolean(more), (el) => el.child(more));
  }

  footer(o) {
    const k = (keys, label, fn, id) => key(o, keys, label, this.guard(id, fn), id);
    if (this.screen === "signIn") {
      return [k([","], "settings", (cx) => this.openSettings(cx), "f-set"), k(["esc"], "close", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.menu) {
      return [k(["↑", "↓"], "choose", () => {}, "f-ch"), k(["enter"], "set", (cx) => this.choose(this.menu.items[this.menu.at], cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen === "story") {
      const s = this.cur;
      const pr = (s.pull_requests ?? [])[this.prAt];
      return [
        k(["s"], "start", (cx) => this.startStory(s, cx), "f-s"),
        k(["t"], "state", (cx) => this.stateMenu(cx), "f-t"),
        ...(this.cfg.priorityField ? [k(["p"], "priority", (cx) => this.priorityMenu(cx), "f-p")] : []),
        k(["o"], "open", (cx) => this.open(s.app_url, cx), "f-o"),
        k(["y"], "copy key", (cx) => this.copy(`sc-${s.id}`, cx), "f-y"),
        k(["b"], "copy branch", (cx) => this.copy(this.branchOf(s), cx), "f-b"),
        ...(pr ? [k(["g"], "github", (cx) => this.openPR(pr, cx), "f-g")] : []),
        k(["esc"], "back", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.screen === "create") {
      return [k(["ctrl", "enter"], "create", (cx) => this.submit(cx), "f-go"), k(["tab"], "next field", (cx) => this.nextField(cx), "f-tab"), k(["esc"], "back", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen === "settings") {
      return [k(["tab"], "next field", (cx) => this.settingsField(1, cx), "f-tab"), k(["esc"], "back", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen !== "list") return [k(["esc"], "back", (cx) => this.escape(cx), "f-esc")];
    const sel = () => this.selected();
    return [
      k(["↑", "↓"], "choose", () => {}, "f-ch"),
      k(["enter"], "open", (cx) => this.enter(cx), "f-go"),
      k(["s"], "start", (cx) => sel() && this.startStory(sel(), cx), "f-s"),
      k(["n"], "new story", (cx) => this.create(cx), "f-n"),
      k(["o"], "Shortcut", (cx) => sel() && this.open(sel().app_url, cx), "f-o"),
      k(["/"], "filter", () => this.input.focus(), "f-filter"),
      k(["r"], "refresh", (cx) => this.refreshAll(cx, { force: true }), "f-r"),
      k([","], "settings", (cx) => this.openSettings(cx), "f-set"),
      k(["esc"], "close", (cx) => this.escape(cx), "f-esc"),
    ];
  }

  // ── drawing: the story ─────────────────────────────────────────────────

  field(o, label, kids) {
    return h_flex().flex_none().gap(10).items_center().min_h(24)
      .child(div().flex_none().w(84).text_size(12).text_color(o.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().items_center().children([kids].flat().filter(Boolean)));
  }

  // Its owners, by count: members are not fetched, so only "you" has a name.
  owners(s) {
    const ids = s.owner_ids ?? [];
    if (!ids.length) return "nobody";
    const others = ids.length - (ids.includes(this.me?.id) ? 1 : 0);
    if (others === ids.length) return `${ids.length} owner${ids.length === 1 ? "" : "s"}`;
    return others ? `you and ${others} other${others === 1 ? "" : "s"}` : "you";
  }

  // A story's screen: its key and name, its state, the fields, the description, its pull requests and branches.
  storyView(o) {
    const s = this.cur;
    const st = this.stateOf(s);
    const color = stateColor(o, st?.type);
    const text = (v) => div().text_color(o.fg).child(String(v));
    const team = s.group_id == null ? null : (this.ref.groups?.data ?? []).find((g) => g.id === s.group_id);
    const prio = this.priorityOf(s);
    const prs = s.pull_requests ?? [];
    const branches = (s.branches ?? []).filter((b) => b.name);
    const paras = String(s.description ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return v_flex().flex_1().min_h(0).gap(10)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(chip(o, "state", [icon(stateIcon(st?.type), color, 12), st?.name ?? "unknown state"], { color, click: (cx) => this.stateMenu(cx) }))
        .child(div().flex_none().font_family(MONO).text_size(12.5).text_color(o.muted).child(`sc-${s.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(16).font_semibold().text_color(o.fg).child(s.name ?? "")))
      .child(v_flex().flex_none().gap(2)
        .child(this.field(o, "Owners", [icon("person", o.dim, 13), text(this.owners(s))]))
        .when(Boolean(team), (el) => el.child(this.field(o, "Team", text(team?.name ?? ""))))
        .when(Boolean(this.epicOf(s)), (el) => el.child(this.field(o, "Epic", chip(o, "epic", [icon("branch", o.dim, 12), this.epicOf(s)?.name ?? ""]))))
        .when(Boolean(this.iterationOf(s)), (el) => el.child(this.field(o, "Iteration", text(this.iterationOf(s)?.name ?? ""))))
        .when((s.labels ?? []).length > 0, (el) => el.child(this.field(o, "Labels", (s.labels ?? []).map((l, i) => chip(o, `lb-${i}`, [l.name])))))
        .when(s.estimate != null, (el) => el.child(this.field(o, "Estimate", text(s.estimate))))
        .when(Boolean(s.deadline), (el) => el.child(this.field(o, "Deadline", [icon("calendar", o.dim, 13), text(String(s.deadline).slice(0, 10))])))
        .when(Boolean(this.cfg.priorityField), (el) => el.child(this.field(o, "Priority", prio ? text(prio) : div().text_color(o.dim).child("none"))))
        .when(Boolean(s.story_type), (el) => el.child(this.field(o, "Type", text(s.story_type)))))
      .child(div().flex_none().h(1).bg(o.line))
      .child(v_flex().id("st-body").h(300).min_h(0).flex_shrink(1).overflow_y_scrollbar().pr(6).gap(8)
        .children(paras.length ? paras.map((p) => div().text_size(13).text_color(o.muted).line_height(1.5).child(p))
          : [div().text_size(13).text_color(o.dim).child("No description.")]))
      .when(prs.length > 0, (el) => el.child(v_flex().flex_none().gap(1)
        .child(div().px(2).pb(2).text_size(10.5).font_semibold().text_color(o.dim).child("Pull requests"))
        .children(prs.map((p, i) => {
          const on = i === this.prAt;
          const tag = p.merged ? ["merged", o.merged] : p.closed ? ["closed", o.fix] : p.draft ? ["draft", o.draft] : null;
          return h_flex().id(`pr-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(on, (el) => el.bg(tint(o.accent, 0.18)))
            .when(!on, (el) => el.hover((h) => h.bg(o.raised)))
            .on_click(this.guard("pr click", (_e, cx) => {
              this.prAt = i;
              this.open(p.url, cx);
            }))
            .child(icon("pr", tag ? tag[1] : o.accent, 13))
            .child(div().flex_none().font_family(MONO).text_size(12).text_color(o.muted).child(`#${p.number}`))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(o.fg).child(p.title ?? ""))
            .when(Boolean(tag), (el) => el.child(chip(o, `prt-${i}`, [tag[0]], { color: tag[1] })));
        }))))
      .when(branches.length > 0, (el) => el.child(this.field(o, "Branches", branches.map((b, i) => chip(o, `br-${i}`, [icon("branch", o.dim, 12), b.name], { mono: true })))))
      .when(Boolean(s.app_url), (el) => el.child(div().id("app-url").flex_none().truncate().text_size(12).text_color(o.accent).cursor_pointer().hover((h) => h.underline())
        .on_click(this.guard("app url", (_e, cx) => this.open(s.app_url, cx)))
        .child(s.app_url ?? "")));
  }

  // ── drawing: a new story ───────────────────────────────────────────────

  // A row of chips for one field, the chosen one lit. items: [{ id, label }].
  chipRow(o, label, id, items, isOn, onPick) {
    return this.field(o, label, items.map((x) => chip(o, `${id}-${x.id}`, [x.label], {
      color: isOn(x) ? o.accent : null,
      click: this.guard(id, (cx) => {
        onPick(x, cx);
        cx.notify();
      }),
    })));
  }

  createView(o) {
    const f = this.form;
    const box = (el) => div().flex_none().px(12).py(8).rounded(8).border_1().border_color(o.line).bg(o.sunk).child(el);
    const groups = (this.ref.groups?.data ?? []).filter((g) => !g.archived);
    const states = [...(this.workflowFor(f.group)?.states ?? [])].filter((s) => s.type !== "done").sort(byPosition);
    const epics = (this.ref.epics?.data ?? []).filter((e) => !e.archived && e.state !== "done");
    const iterations = this.iterationsFor(f.group);
    const prio = this.cfg.priorityField && (this.ref.customFields?.data ?? []).find((x) => x.id === this.cfg.priorityField);
    const none = { id: "none", label: "None", value: null };
    return v_flex().flex_none().gap(10)
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("New story"))
      .child(box(Input.new(this.title).w_full().text_size(13).text_color(o.fg)))
      .child(box(Textarea.new(this.desc).w_full().text_size(13).text_color(o.fg)))
      .when(groups.length > 0, (el) => el.child(this.chipRow(o, "Team", "tm", groups.map((g) => ({ id: g.id, label: g.name, value: g })), (x) => x.value.id === f.group?.id, (x, cx) => this.pickTeam(x.value, cx))))
      .when(states.length > 0, (el) => el.child(this.chipRow(o, "State", "st", states.map((s) => ({ id: s.id, label: s.name, value: s.id })), (x) => x.value === f.state, (x) => (f.state = x.value))))
      .child(this.chipRow(o, "Type", "ty", ["feature", "bug", "chore"].map((t) => ({ id: t, label: t, value: t })), (x) => x.value === f.type, (x) => (f.type = x.value)))
      .child(this.chipRow(o, "Epic", "ep", [none, ...epics.map((e) => ({ id: e.id, label: e.name, value: e.id }))], (x) => x.value === f.epic, (x) => (f.epic = x.value)))
      .child(this.chipRow(o, "Iteration", "it", [none, ...iterations.map((i) => ({ id: i.id, label: i.name, value: i.id }))], (x) => x.value === f.iteration, (x) => (f.iteration = x.value)))
      .child(this.chipRow(o, "Owner", "ow", [{ id: "me", label: "me", value: true }], (x) => f.mine === x.value, () => (f.mine = !f.mine)))
      .when(Boolean(prio), (el) => el.child(this.chipRow(o, "Priority", "pr", [none, ...(prio.values ?? []).filter((x) => x.enabled !== false).sort(byPosition).map((x) => ({ id: x.id, label: x.value, value: x.id }))], (x) => x.value === f.priority, (x) => (f.priority = x.value))));
  }

  menuView(o) {
    const m = this.menu;
    const title = {
      state: `Move sc-${this.cur?.id} to`,
      priority: `sc-${this.cur?.id}'s priority`,
      branch: `Which branch for sc-${this.branching?.story.id}?`,
      startState: `Start state for ${(this.ref.workflows?.data ?? []).find((w) => w.id === m.wf)?.name ?? "the workflow"}`,
      cfgPriority: "Priority field",
      launcher: "Launcher",
    }[m.kind] ?? "";
    return v_flex().flex_none().gap(2).p(10).rounded(10).border_1().border_color(o.line).bg(o.raised).shadow_md()
      .when(Boolean(title), (el) => el.child(div().px(6).pb(6).text_size(13).font_semibold().text_color(o.fg).child(title)))
      .children(m.items.map((it, i) => {
        const on = i === m.at;
        return h_flex().id(`mi-${i}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(tint(o.accent, 0.18)))
          .when(!on, (el) => el.hover((s) => s.bg(o.sunk)))
          .on_click(this.guard("menu", (_e, cx) => this.choose(it, cx)))
          .child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(String(i + 1)))
          .child(div().text_size(13).when(on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(it.label));
      }));
  }

  // The start's question about a workflow with no start state, and its states as a menu.
  pickStateView(o) {
    const { story, workflow } = this.pick;
    return v_flex().flex_none().gap(12).px(14).py(14)
      .child(div().text_size(15).font_semibold().text_color(o.fg).child(`Start sc-${story.id}`))
      .child(div().text_size(13).text_color(o.muted).line_height(1.5)
        .child(`sc-${story.id} is in the ${workflow.name} workflow, which has no start state yet. Pick one:`))
      .child(this.menuView(o));
  }

  // ── drawing: sign-in ───────────────────────────────────────────────────

  signInView(o) {
    return v_flex().flex_none().gap(12).px(14).py(18).items_start()
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("Sign in to Shortcut"))
      .when(Boolean(this.signInNote), (el) => el.child(div().text_size(13).text_color(o.fix).child(this.signInNote)))
      .child(div().text_size(13).text_color(o.muted).line_height(1.5).child(
        `The popup needs a Shortcut API token (Shortcut → Settings → API Tokens). Either export it in your login shell as $${this.cfg.auth.env ?? DEFAULTS.auth.env} (the variable name can be changed in settings), or paste the token in settings, where it is kept in data/shortcut.json, readable only by you. Then open this again.`))
      .child(h_flex().id("signin-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
        .on_click(this.guard("settings", (_e, cx) => this.openSettings(cx)))
        .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("Open settings")));
  }

  render() {
    const t = theme();
    const o = tones(t);
    const scr = this.screen;
    this.shown = scr === "list" ? this.shownRows() : [];
    if (scr === "list") this.pickRow(this.shown);
    const note = this.busy || this.err || this.flash;
    const noteColor = this.busy ? o.accent : this.err ? o.fix : o.muted;
    return v_flex()
      .id("shortcut")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .track_focus(this.focus)
      .on_key_down(this.guard("key", (e, cx) => this.keys(e, cx)))
      .when(scr === "list", (el) => el
        .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
          .child(icon("search", o.dim, 15))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg))
          .child(div().flex_none().text_size(12).text_color(o.muted).child("Shortcut")))
        .child(this.tabBar(t, o))
        .child(this.listView(o)))
      .when(scr === "story" && Boolean(this.cur), (el) => el.child(this.storyView(o)))
      .when(scr === "create" && Boolean(this.form), (el) => el.child(this.createView(o)))
      .when(scr === "pickState" && Boolean(this.pick && this.menu), (el) => el.child(this.pickStateView(o)))
      .when(scr !== "pickState" && Boolean(this.menu), (el) => el.child(this.menuView(o)))
      .when(scr === "signIn", (el) => el.child(this.signInView(o)))
      .when(scr === "settings" && Boolean(this.envInput), (el) => el.child(this.settingsView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}
