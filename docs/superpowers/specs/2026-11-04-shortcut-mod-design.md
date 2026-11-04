# Design: the `shortcut` mod for the Herdr app, and the launch contract

Date: 2026-11-04
Status: design for review, nothing built
Related: `~/gitprojects/herdr-projects/docs/superpowers/specs/2026-11-02-projects-mod-design.md` (the projects mod this hands off to)

## 1. What this is

A Shortcut (app.shortcut.com) popup for the Herdr app, modeled on herdr-linear (`mrolafsson/herdr-linear`, MIT): browse the stories that matter to you, read one, create one, and **start** one. Starting a story does the Shortcut-side bookkeeping (move it to the workflow's start state, add me as an owner, put it in the current iteration) and then hands "make me a place to work on branch X with this first prompt" to a **launcher**: either Herdr's shipped worktree dialog or any installed mod that implements the launch contract in section 7. The user's own `projects` mod gets that entry point as part of this work.

The mod is a **finder and starter**. It never decides how a work area is built (worktree location, env files, setup commands, tabs) or which agent runs with what options. Those belong to the launcher.

Three deliverables, in this order:

1. The **launch contract** (section 7), a props shape any mod can accept.
2. The **`projects` mod launch entry** (section 8.3) in `~/gitprojects/herdr-projects`.
3. The **`shortcut` mod** itself, in this repo, built against both launchers from the start.

Follow-up, not in this work: fork the installed `github` mod so it hands PR branches to the same launcher (section 12).

## 2. Goals, non-goals, anti-goals

**Goals**
- Open with one key, see my stories at once (cached), refresh in the background.
- Read a story well enough to decide whether to start it: description, state, owners, epic, iteration, labels, PRs and branches, the optional priority field.
- Start a story in one action: Shortcut updates, then the launcher takes over.
- Everything that varies per workspace is configured in the mod's own settings screen: token or env var, start state per workflow, start prompt, branch template, iteration policy, priority field, launcher.
- Create a story without leaving the app.
- Keep herdr-linear's look and keyboard model so the two feel like siblings.

**Non-goals**
- Multiple machines. Local only. Nothing in the design blocks adding `machine` later, but nothing implements it.
- A Go helper binary. Shortcut's token auth and plain JSON need none; the mod calls `fetch` itself.
- Shortcut REST v4 (beta). Its search does not resolve the signed-in member and its member-stories endpoint has no state filter. v3 throughout.
- Editing stories beyond what start, create and the detail screen's state/priority menus need. No comments, no description editing.
- Deciding anything about worktrees, setup or agents. Even the "shipped" launcher path passes only a folder and a branch.

**Anti-goals**
- Removing an existing owner. Start only ever adds.
- Printing, logging or committing the token. It is read into memory, sent in one header, and otherwise never appears, not in logs, not in `herdr-app ls`, not in the cache file.
- A start that half-happens silently. If Shortcut rejects the update, nothing is launched and the error is shown.
- Guessing a start state. A workflow without a configured one asks, once, and persists the answer.

## 3. Names and files

Repo: `~/gitprojects/herdr-shortcut` (this one). Layout mirrors herdr-projects:

```
mods/shortcut/
  mod.json        { "place": "none", "title": "Shortcut", "overlay": { "kind": "popup", "at": "top", "offset": 40, "width": 0.8, "height": 0.8 } }
  main.js         the View: screens, keys, start flow
  api.js          Shortcut v3 client: fetch wrapper, endpoints, paging, cache
  config.js       load/normalize/save ~/.config/herdr-app/data/shortcut.json, token resolution
  launch.js       builds the launch request, opens the configured launcher
  look.js         tones, icons, chips, keycaps (ported from herdr-linear's look.js)
  icons/          SVGs copied from herdr-linear (MIT; attribution kept in LICENSE-herdr-linear)
keys.json         the bindings to merge into ~/.config/herdr-app/keys.json
test/             node --test files with a fake `herdr` module, as herdr-projects does
RECIPE.md         install and update steps for a person or an agent
README.md
```

Installed copy: `~/.config/herdr-app/mods/shortcut/`. Data: `~/.config/herdr-app/data/shortcut.json` (settings) and `~/.config/herdr-app/data/shortcut-cache.json` (API cache, safe to delete). `herdr-app check shortcut` must pass after every change; `herdr-app shot` for a visual check; every config change goes in `~/.config/herdr-app/CUSTOMIZATIONS.md`.

The projects mod changes live in `~/gitprojects/herdr-projects` on their own branch, with their own tests, and are installed by that repo's recipe.

## 4. Shortcut API

Base `https://api.app.shortcut.com/api/v3`, header `Shortcut-Token: <token>`, `Content-Type: application/json`, 200 requests/minute. Every call goes through one `api(method, path, body)` in `api.js` that adds the header, parses JSON, maps non-2xx to an `Error` with Shortcut's `message` field, and never logs the request headers.

| Need | Call |
|---|---|
| Who am I | `GET /member` → `{ id, mention_name, name }` |
| Workflows and states | `GET /workflows` → `[{ id, name, states: [{ id, name, type, position }] }]`; `type` ∈ backlog, unstarted, started, done |
| Teams | `GET /groups` → `[{ id, name, mention_name, member_ids, archived }]` |
| Epics | `GET /epics` (only `archived: false`, `completed: false` are listed) |
| Iterations | `GET /iterations` → `[{ id, name, status, group_ids, start_date, end_date }]`; `status` ∈ unstarted, started, done |
| Custom fields | `GET /custom-fields` → `[{ id, name, enabled, values: [{ id, value, enabled, position }] }]` |
| My stories | `POST /stories/search` `{ owner_ids: [me], workflow_state_types: ["unstarted","started"], archived: false }` → `{ data, next, total }`; follow `next` |
| Team stories | `POST /stories/search` `{ group_ids: [g], workflow_state_types: ["started"], archived: false }` |
| Epic stories | `POST /stories/search` `{ epic_ids: [e], archived: false }` |
| Text search | `GET /search/stories?query=<text>&page_size=25` (operators pass through; `owner:me` does not work via API, so "Mine" never uses this) |
| One story | `GET /stories/{id}` |
| Start | `PUT /stories/{id}` with only the fields that change: `workflow_state_id`, `owner_ids`, `iteration_id` |
| Create | `POST /stories` `{ name, description, group_id, workflow_state_id, owner_ids, epic_id, iteration_id, story_type, custom_fields }` |
| State / priority menu | `PUT /stories/{id}` `{ workflow_state_id }` or `{ custom_fields: [{ field_id, value_id }] }` |

Story fields the mod reads: `id`, `name`, `description`, `story_type`, `workflow_id`, `workflow_state_id`, `owner_ids`, `requested_by_id`, `group_id`, `epic_id`, `iteration_id`, `labels[].name`, `custom_fields[] { field_id, value_id, value }`, `pull_requests[] { number, title, url, merged, closed, draft, branch_name }`, `branches[] { name, repository_id, url }`, `app_url`, `updated_at`, `archived`, `estimate`, `deadline`.

**Cache.** `shortcut-cache.json` holds the member, workflows, groups, epics, iterations, custom fields and the last list result per tab, each with a fetched-at time. Opening the popup renders from cache immediately and refreshes everything older than 60 s (reference data: 10 min) in the background, as herdr-linear does. A 401 clears the cached member and shows the sign-in screen.

**Paging.** `POST /stories/search` is followed through `next` up to 10 pages for Mine, 4 for the others. The list shows a "more…" footer when a page was cut.

## 5. Settings (`data/shortcut.json`)

```jsonc
{
  "auth": { "env": "SHORTCUT_API_TOKEN" },          // or { "token": "…" }; env is the default
  "startPrompt": "Read the shortcut story {id} for context, then suggest how to proceed.",
  "branchTemplate": "{mention}/sc-{id}/{slug}",
  "startStates": { "500000011": 500000013 },        // workflow id → state id
  "iteration": "current-if-unset",                   // or "never"
  "priorityField": null,                             // custom field id, or null for none
  "launcher": { "kind": "shipped" },                  // or { "kind": "mod", "name": "projects" }
  "recent": [ { "id": 1234, "at": "2026-11-04T…" } ]  // last 30 started/opened, newest first
}
```

`config.js` exports `load()`, `save(cfg)`, `normalize(raw)` (fills every default, drops unknown keys, tolerates a missing or broken file by returning defaults and remembering the error for the settings screen), and `resolveToken(cfg)`.

**Token resolution.** `auth.token` wins when present. Otherwise `auth.env` names a variable; it is read with `exec("sh", ["-lc", 'printf %s "$NAME"'])` once per popup open (the user's login shell, so tokens exported in `.zshrc`/`.zprofile` work; the projects mod's `inUserShell` is the precedent). The variable name is validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` before it is interpolated. An empty result shows the sign-in screen with the variable's name. When a token is pasted in settings it is saved to `shortcut.json`, and that file is written with mode `0600` (via `exec("chmod")` after `writeTextFile`, since the file API has no mode). The settings screen shows the token as `••••` plus its last four characters and a "Clear" action; it never shows the whole value again.

**Template variables.** `startPrompt` and `branchTemplate` expand `{id}` → `sc-1234`, `{number}` → `1234`, `{slug}` → the story name slugged (lowercase, `[^a-z0-9]+` → `-`, trimmed, max 48 chars), `{title}` → the story name verbatim, `{url}` → `app_url`, `{mention}` → my `mention_name`, `{branch}` (prompt only) → the branch name. Unknown `{…}` are left as typed.

## 6. Screens

All screens are one `View` with `this.screen` ∈ `list | story | create | settings | pickState | signIn`, rendered as herdr-linear does (top bar with tabs and filter, virtual list, detail panes, keycap hints along the bottom). Visuals: port `look.js` (tones, chips, keycaps, `JetBrains Mono`) and the icon set. State colors come from the state's `type` because this workspace's states carry no colors: backlog grey, unstarted blue, started yellow, done green.

**List.** Tabs: **Mine** (owner me, unstarted + started, grouped by state in workflow position order), **Team** (my groups' started stories, a group chooser when I'm in several), **Epics** (open epics; Enter drills into the epic's stories), **Recent** (from settings). A filter box narrows by text; typing a story key (`sc-1234`, `#1234`, or `1234`) looks that story up workspace-wide and offers it as the first row. Rows show: state icon, `sc-1234`, name, chips for epic, iteration, labels, PR count, priority value when a priority field is configured. Enter opens the story. `s` starts it from the list. `n` opens create. `,` opens settings. `r` refreshes.

**Story.** Title, key, `app_url` (Enter on it opens the browser via `run("open", …)`'s equivalent `exec("open", [url])`), description rendered as plain text with paragraph breaks (Markdown rendering is left to the builder, plain text is acceptable), a sidebar with state (menu, `t`), owners, requester, team, epic, iteration, labels, estimate, deadline, priority (menu, `p`, only when configured), branches and PRs (Enter on a PR opens it in the browser; if the installed `github` mod exists, offer "open in github mod" via `openOverlay({ mod: "github", kind: "dialog", props: { …, backTo } })` exactly as herdr-linear does; the props the github mod accepts are read from its `main.js` header at build time). `s` starts. Esc goes back.

**Create.** Fields: name (required), description, team (default: my first group), workflow state (default: the team's workflow's first `unstarted` state), type (feature/bug/chore), epic (optional), iteration (optional), owners (me by default, toggle), priority (when configured). Submit with ctrl+Enter; on success open the new story's screen with a "Start" hint. Same layout as herdr-linear's create screen.

**Settings.** Sections, each a row with a value and a hint, edited inline:
- *Auth*: radio "Environment variable" (text: name, default `SHORTCUT_API_TOKEN`) / "Token" (paste box). "Test" calls `GET /member` and shows the member's name or the error.
- *Start prompt*: textarea, the variables listed under it.
- *Branch name*: text, the variables listed under it, a live preview for a sample story.
- *Start state per workflow*: one row per workflow from the API, a dropdown of that workflow's states (excluding `done`), first option "Please select a start state". Unset rows are marked.
- *Iteration*: "Set to the current iteration if the story has none" / "Never touch the iteration".
- *Priority field*: dropdown of enabled custom fields that have values, first option "None". Choosing one makes priority chips and the `p` menu appear.
- *Launcher*: dropdown: "Shipped worktree dialog" and one "Mod: ‹name›" per folder under `${appHome()}/mods` whose `main.js` exists (listed with `exec("ls", [dir])`; no error if the list fails, the current value is still shown and a free-text fallback is offered). The chosen mod is not validated beyond existing; the contract is trusted.
Settings save on every change (debounced 300 ms) and show "Saved" or the write error.

**pickState.** A dialog-like screen inside the popup: "sc-1234 is in the ‹workflow› workflow, which has no start state yet. Pick one:" followed by the workflow's non-done states. Enter persists the choice into `startStates` and resumes the start. Esc cancels the start.

**signIn.** Shown when no token resolves or the API says 401: explains the two ways to provide a token and has a button to open settings.

## 7. The launch contract (v1)

A **finder** (shortcut, later github) asks a **launcher** to make a place to work. The launcher is opened as a dialog with these props:

```js
openOverlay({
  mod: "<launcher mod name>", kind: "dialog", width: 0.8, height: 0.8,
  props: {
    launch: {
      v: 1,
      branch: "jeremy/sc-1234/fix-the-thing",   // required: the full branch name
      checkout: "new",                          // "new": create from the launcher's base; "existing": check out this branch (local or origin/<branch>)
      name: "sc-1234 · Fix the thing",          // optional: a suggested space name
      prompt: "Read the shortcut story …",      // optional: the agent's first message, launcher decides who gets it
      source: { kind: "shortcut", id: "sc-1234", url: "https://app.shortcut.com/…", title: "Fix the thing" },
      repo:   { names: ["vizion-api"], urls: ["https://github.com/org/vizion-api"], folder: null } // optional hints
    },
    backTo: { mod: "shortcut", props: { screen: "story", id: 1234 } }  // optional, the linear↔github convention
  }
})
```

Launcher obligations:
- Accept being opened this way even when it also has a popup role. Decide by `props().launch`.
- Make the work area and open it as Herdr spaces/tabs, by whatever means it owns. Honor `branch` verbatim; it may suffix `-2`, `-3` when taken, and should say so.
- `checkout: "existing"` means the branch already exists (a PR branch): fetch, then `git worktree add <path> <branch>` tracking `origin/<branch>` when it is remote-only. `"new"` means create it from the launcher's own base.
- When it cannot resolve the repo from `repo` hints, show its own chooser with `branch` and `prompt` already filled in, rather than failing.
- Deliver `prompt` to the agent it starts, if it starts one. A launcher that starts no agent may drop the prompt.
- Close itself when done or cancelled. Never touch the ticket; that is the finder's job and it happened before the handoff.
- Ignore fields it does not understand; refuse `v` values it does not know with a visible message.

Finder obligations:
- Do all ticket-side work first, and only open the launcher when that succeeded.
- Pass nothing about agents, worktree roots, base branches or setup.
- Close its own popup after the handoff. *Builder note:* verify that closing the popup does not close the dialog it opened (herdr-linear keeps its popup open under the github dialog, so it has not been needed). If it does, keep the popup open and pass `launch.opener = <this popup's overlay id>` so the launcher closes it on success; add that field to the contract.

**The shipped launcher.** `launcher.kind === "shipped"` opens Herdr's own worktree dialog with the subset it understands:

```js
openOverlay({ mod: "worktree", kind: "dialog", props: { folder, machine: null, branch, space } })
```

where `space` is the selected space's id and `folder` is that space's working folder (the first live terminal's cwd in the space, else the space's folder, the same rule the shipped spaces mod uses). The dialog branches from that checkout's HEAD, creates the worktree under `~/.herdr/worktrees/<repo>/<slug>` and opens a space with a shell. No agent, no prompt. If a `projects` entry has `autoLayout` on for that repo, its watcher builds the tabs and agent afterwards. Before opening it, the finder checks that a space is selected and that its folder is inside a git repo (`git -C folder rev-parse --show-toplevel`); otherwise it shows "Select a space in the repo first, or choose a launcher mod in settings" and does not start. `checkout: "existing"` is passed as `branch` only; the shipped dialog checks out a local branch of that name itself and cannot fetch remote-only branches, which the finder states in the same message when the branch is not local.

## 8. Starting a story

### 8.1 Steps

1. Resolve the token. None → signIn.
2. `GET /stories/{id}` fresh, so the update is built from current data.
3. Find `startStates[story.workflow_id]`. Missing → pickState; on Enter persist and continue; Esc aborts.
4. Build the update:
   - `workflow_state_id`: the configured start state, only when the story's current state is of type `backlog` or `unstarted`. A story already in a `started` state keeps its state, and the start notes say "state kept: ‹name›". A story in a `done` state is **refused**: the story screen shows "sc-1234 is done. Follow-up work belongs in a new story." and no update or launch happens. (A "create follow-up story" action is a possible later addition.)
   - `owner_ids`: `story.owner_ids` plus my id, only if I am not already in it. Order preserved, me appended.
   - `iteration_id`: only when `iteration === "current-if-unset"`, `story.iteration_id` is null, and exactly one iteration has `status: "started"` and (if the story has a `group_id`) lists that group in `group_ids`, or has no groups at all. Zero or several candidates → leave the iteration alone and show "iteration not set: ‹reason›" in the start notes; never guess.
5. If the update is non-empty, `PUT /stories/{id}`. On error: show it on the story screen, stop.
6. Choose the branch, in this order: the `branch_name` of an open pull request on the story (`merged: false`, `closed: false`); else a branch listed in `story.branches[]`; else the expanded `branchTemplate`. When more than one candidate exists at the chosen level, the start screen lists them and asks which to use (Esc aborts). A reused branch gives `checkout: "existing"`; the template gives `"new"`. Then expand `startPrompt` (its `{branch}` is the chosen branch). `repo` hints come from `story.branches[].url` and `pull_requests[].url` (repo name = the path segment before `/pull/` or `/tree/`), empty when none.
7. Push `{ id, at }` to `recent`, save settings.
8. Open the launcher (section 7), then close the popup.

### 8.2 Starting an already-started story

Allowed. Step 4 keeps the state, adds me as owner if needed, and the launcher is opened as usual, with `checkout: "existing"` when a PR or story branch exists. This is how "resume work" happens. Starting a `done` story is refused (step 4).

### 8.3 The `projects` mod launch entry

In `~/gitprojects/herdr-projects/mods/projects/main.js`, the picker role gains a third way in, beside the key-opened picker and the demo file: `props().launch`. When present at `init`:

1. Validate `v === 1`; otherwise show the picker with a red banner "Unknown launch request version" and do nothing else.
2. Resolve the project: `repo.folder` equal to a project's path or inside its worktree root; else `repo.names` / basenames of `repo.urls` equal to a project's name or the basename of its path (case-insensitive). Exactly one match → that project. Zero or more than one → the normal list with a banner "Starting ‹source.id› on ‹branch›: pick a project"; picking one continues with step 3.
3. `openLaunch(project)` with `worktree: true`, branch text = `launch.branch` (it contains a slash, so `createWorktree` uses it verbatim; the preview shows it and any `-N` suffix), prompt box = `launch.prompt ?? project default`. Focus the launch button so ctrl+Enter or Enter goes. The launch is not fired automatically: layout and agent timing are still the person's call on this screen (my call, see section 13).
4. `checkout: "existing"` is a new option through `createWorktree(project, text, log, { existing: true })`: after the fetch, if `refs/heads/<branch>` exists use it, else if `refs/remotes/<remote>/<branch>` exists `git worktree add --track -b <branch> <path> <remote>/<branch>`, else fail with "branch ‹x› not found locally or on ‹remote›". No `-N` suffixing in this mode; a taken path means the worktree already exists, and the launcher offers to open it instead (the existing `adoptExisting` path).
5. `launch.name` is ignored; the project's `spaceName` template wins (my call).
6. `backTo` is honored on Esc from the launch screen exactly as the github mod does: `openOverlay({ mod: backTo.mod, kind: "popup", props: backTo.props })`, then close.

Tests in `herdr-projects/test`: launch request parsing, project resolution by folder/name/url, the existing-branch worktree path (fake git), and the banner states.

## 9. Keys

`keys.json` in this repo, merged into `~/.config/herdr-app/keys.json` at install:

```json
{ "global": { "cmd-alt-s": "mod.open:shortcut" },
  "mod:shortcut": { "escape": "shortcut.escape", "tab": "shortcut.tab", "shift-tab": "shortcut.backtab" } }
```

`cmd-alt-s` is my call: it pairs with the projects mod's `cmd-alt-p` and is free in the current `keys.json`. Inside the popup (handled by the View, not keys.json, as herdr-linear does): `j/k` or arrows move, Enter opens, `s` start, `n` create, `,` settings, `r` refresh, `/` focus filter, `t` state menu, `p` priority menu, `o` open in browser, `1..4` switch tabs, Esc back/close.

## 10. Errors and edge cases

- No network / 5xx: the list keeps showing the cache with a "offline, showing cached" line; start refuses with the error.
- 429: wait for `Retry-After` once, then show the error. The mod never retries in a loop.
- A story in a workflow whose configured start state no longer exists: treat as unconfigured (pickState) and drop the stale entry.
- Archived story: shown greyed in Recent, start refuses. Done story: start refuses (section 8.1).
- `startPrompt` empty: no prompt is passed; the launcher starts its agent bare or not at all.
- `branchTemplate` producing an invalid ref (checked with `git check-ref-format --branch` via `exec`): start refuses and points at settings.
- Empty `repo` hints are the common case: an unstarted story has no branches or PRs. The projects launcher then shows its list with the banner, and the shipped path uses the selected space. No team/epic/label-to-project mapping in v1 (see follow-ups).
- The configured launcher mod folder is gone: start shows "launcher ‹name› is not installed" with a link to settings; it does not fall back silently.
- Shared machines: not supported; `machine` is always null.

## 11. Testing and verification

- `node --test test/` with a fake `herdr` module (copy herdr-projects' `test/helpers` approach): `normalize()`, token resolution (env name validation, pasted token wins), template expansion and slugging, start-update construction (owner append, no removal, iteration candidates), launch request building for both launcher kinds, API client error mapping with a fake `fetch`, paging.
- `herdr-app check shortcut` after every change; `herdr-app shot` to look at list, story, create, settings, pickState.
- Live calls against the real workspace: read-only calls (`GET /member`, workflows, searches) may run freely with the shell's token. Writes (`PUT`, `POST`) run only against a story the person names at that moment; the plan's live-verification task asks for one before any write and never creates stories on its own. The API client's own tests use a fake `fetch`.
- Response shapes were checked against Shortcut's v3 OpenAPI document during design: `pull_requests[]` and `branches[]` on a story, `workflow_state_types`, `group_ids`, `epic_ids` and `iteration_ids` in the search body, `custom_fields` on create and update.

## 12. Follow-ups (separate work, not in this plan)

1. **Fork the installed `github` mod** (`~/.config/herdr-app/mods/github`) so it reads the same `launcher` setting (or its own copy of it) and, when a PR is picked for review, hands `{ branch: pr.headRefName, checkout: "existing", prompt: <its review prompt>, source: { kind: "github", … }, repo: { urls: [pr.repoUrl] } }` to the launcher instead of making its own worktree and picking the first agent. Record the fork in `CUSTOMIZATIONS.md`.
2. **Prompt relay for the shipped path.** The finder could leave `{ branch, prompt, source }` in `shared("launch.pending")` and the projects watcher, when it builds a space whose branch matches, could type the prompt. Makes the shipped path complete without coupling. Needs its own small design.
3. Multiple machines (`machine` in the contract and in the shipped-launcher props).
4. A settings mapping from Shortcut team, epic or label to a project name, so `launch.repo.names` is filled on first starts and the projects launcher can skip its list.

## 13. Calls I made (check these while reading)

- Repo and file layout mirror herdr-projects; look and icons are ported from herdr-linear under its MIT license.
- Default global key `cmd-alt-s`.
- Default token source is the `SHORTCUT_API_TOKEN` environment variable (it exists in your shell today); a pasted token is stored in `data/shortcut.json` with mode 0600.
- Default branch template `{mention}/sc-{id}/{slug}` since this workspace returns no `formatted_vcs_branch_name`.
- Start never moves a story backwards: the state changes only from backlog/unstarted states, and done stories are refused (your decision).
- On resume, an open PR's branch wins over a story branch, which wins over the template; several candidates ask (your decision).
- Iteration is set only when exactly one started iteration fits the story's team; otherwise it is left alone and said so.
- The projects launch entry shows the launch screen prefilled and waits for Enter rather than launching at once.
- The projects launcher ignores `launch.name`; its own space-name template wins.
- The shipped launcher path checks that the selected space is in a git repo before opening the worktree dialog, and passes no agent.
- List tabs are Mine, Team, Epics, Recent; text search lives in the filter box rather than a tab.
- Settings save on change, no Save button.

## 14. Left to the builder

- Markdown rendering of descriptions (plain text with paragraphs is acceptable for v1).
- Exact layout, spacing and colors beyond "like herdr-linear".
- How the Team tab picks a group when I'm in several (a chooser row is enough).
- Debounce and refresh intervals within the stated bounds.
- The shape of `api.js` paging helpers and the cache file's internal layout.
- Whether `exec("open", [url])` or a herdr command is the right way to open a browser on macOS (herdr-linear's approach is the reference).
