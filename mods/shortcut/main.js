// The Shortcut popup: your stories, a filter that also finds any story by its key, and (in later screens) a story,
// a new story and the settings. One View; `this.screen` says which screen is drawn. Ported from herdr-linear's view,
// with its binary layer replaced by the Shortcut API client.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { theme, props, closeOverlay, nextCommand } from "herdr";
import { load as loadSettings, resolveToken, normalize, DEFAULTS } from "./config.js";
import { createClient, ApiError, readCache, writeCache, fresh } from "./api.js";
import { tones, icon, chip, key, countPill, stateIcon, stateColor, MONO } from "./look.js";

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
      for (;;) {
        const c = await nextCommand();
        if (c === "escape") this.escape(cx);
        else if ((c === "tab" || c === "backtab") && this.screen === "list") this.step(c === "tab" ? 1 : -1, cx);
        cx.notify();
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

  // Settings, then the token, then what was kept from last time (drawn at once), then fresh data.
  async boot(cx) {
    const s = await loadSettings();
    this.cfg = s.cfg;
    this.raw = s.raw;
    this.cfgError = s.error;
    const { token, error } = await resolveToken(this.cfg);
    this.cache = await readCache();
    for (const k of REF) if (this.cache[k]) this.ref[k] = this.cache[k];
    this.lists = { ...(this.cache.lists ?? {}) };
    if (error || !token) {
      this.screen = "signIn";
      this.signInNote = error ?? `No API token: $${this.cfg.auth.env} is empty or unset in your login shell.`;
      return cx.notify();
    }
    this.client = createClient({ token });
    cx.notify();
    this.refreshAll(cx);
  }

  get me() {
    return this.ref.member?.data ?? null;
  }

  // Reference data older than 10 minutes and the shown tab's list older than a minute (everything, when forced),
  // in one task; the cache is written once at the end.
  refreshAll(cx, { force = false } = {}) {
    if (!this.client || this.refreshing) return;
    this.refreshing = true;
    const tab = this.tab;
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

  // One tab's list, into this.lists and the cache (not written: the caller keeps it).
  async load(tab, cx) {
    if (tab !== "mine") return; // the other tabs come with their own queries
    this.loading.add(tab);
    cx.notify();
    try {
      const body = { owner_ids: [this.me.id], workflow_state_types: ["unstarted", "started"], archived: false };
      const { data, cut } = await this.client.searchStories(body, { pages: 10 });
      this.lists[tab] = (this.cache.lists ??= {})[tab] = { at: Date.now(), data, cut };
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

  // The shown tab's stories that pass the filter (not the looked-up one).
  localRows() {
    const f = this.filter.trim().toLowerCase();
    return (this.lists[this.tab]?.data ?? []).filter((s) => this.matches(s, f));
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

  // The rows shown: { header } and { story }. The looked-up story comes first; the workspace's search results
  // come last, under their own heading, when nothing here matches.
  shownRows() {
    const q = this.filter.trim();
    const found = this.found && STORY_KEY.test(q) ? this.found : null;
    const local = this.localRows().filter((s) => s.id !== found?.id);
    const rows = found ? [{ story: found }] : [];
    rows.push(...this.grouped(local));
    if (!local.length && this.searched?.query === q && this.searched.data.length) {
      rows.push({ header: "Workspace", type: null }, ...this.searched.data.map((story) => ({ story })));
    }
    return rows;
  }

  // The chosen row moves over stories only, skipping the headings.
  move(d) {
    const rows = this.shown ?? this.shownRows();
    for (let i = this.at + d; i >= 0 && i < rows.length; i += d) {
      if (rows[i].story) {
        this.at = i;
        return this.follow();
      }
    }
  }

  // Keeps the chosen row in sight: the first, with its heading.
  follow() {
    const rows = this.shown ?? [];
    const first = rows.findIndex((r) => r.story);
    this.scroll.scroll_to_item(this.at === first ? 0 : this.at);
  }

  selected() {
    return (this.shown ?? this.shownRows())[this.at]?.story ?? null;
  }

  step(d, cx) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.pickTab(TABS[(i + d + TABS.length) % TABS.length].id, cx);
  }

  pickTab(id, cx) {
    this.tab = id;
    localStorage.setItem("tab", id);
    this.at = 0;
    this.refreshAll(cx);
    cx.notify();
  }

  enter(cx) {
    const s = this.selected();
    if (s) this.openStory(s, cx);
  }

  // ── actions (the screens they lead to come in later tasks) ─────────────

  openStory(story, cx) {
    this.cur = story;
    this.screen = "story";
    cx.notify();
  }

  startStory(_story, _cx) {}

  create(_cx) {}

  openSettings(_cx) {}

  open(url, cx) {
    if (url) cx.open_url(url);
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  escape(cx) {
    if (this.screen === "list" && this.typing) {
      this.focus.focus?.();
      this.typing = false;
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
    else if (this.screen === "list") handled = this.listKey(k, cx);
    else if (this.screen === "signIn") handled = this.signInKey(k, cx);
    else handled = false;
    if (!handled) return;
    cx.stop_propagation();
    cx.notify();
  }

  // Arrows always move; letters act only when the filter doesn't have the keyboard.
  listKey(k, cx) {
    const s = this.selected();
    if (k === "down") this.move(1);
    else if (k === "up") this.move(-1);
    else if (k === "pagedown") for (let i = 0; i < 12; i++) this.move(1);
    else if (k === "pageup") for (let i = 0; i < 12; i++) this.move(-1);
    else if (this.typing) return false;
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
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(o.fg).child(s.name ?? ""))
      .child(h_flex().flex_none().gap(6).items_center().overflow_hidden().children(chips));
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
    const l = this.lists[this.tab];
    const notes = [];
    if (!rows.some((r) => r.story) && !this.err) {
      notes.push(this.note(o, !l ? "Loading…"
        : this.filter ? "Nothing matches. A story's key (sc-1234, #1234 or 1234) looks in the whole workspace."
        : this.tab === "mine" ? "No unstarted or started stories of yours." : "Nothing here yet."));
    }
    const entries = rows.map((r, i) => {
      if (r.header) {
        let n = 0;
        for (let j = i + 1; j < rows.length && rows[j].story; j++) n++;
        return { key: `h-${i}-${r.header}`, h: HEADING_H, el: () => this.heading(o, r.header, r.type ? stateColor(o, r.type) : null, n) };
      }
      return { key: `r-${i}-${r.story.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(this.storyCard(o, r.story, i === this.at)) };
    });
    const more = l?.cut ? div().px(14).py(6).text_size(11.5).text_color(o.dim).child(`more… only the first ${l.data.length} are shown; the filter narrows them.`) : null;
    return v_flex().flex_1().min_h(0).gap(2)
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
    // The chosen row is always a story: the first at or after it, else the last one.
    if (scr === "list" && !this.shown[this.at]?.story) {
      let i = this.shown.findIndex((r, j) => j >= this.at && r.story);
      for (let j = this.shown.length - 1; i < 0 && j >= 0; j--) if (this.shown[j].story) i = j;
      this.at = Math.max(0, i);
    }
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
      .when(scr === "signIn", (el) => el.child(this.signInView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}
