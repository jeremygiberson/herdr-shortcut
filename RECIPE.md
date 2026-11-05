# Shortcut

A Shortcut (app.shortcut.com) popup for the Herdr app. `cmd-alt-s` opens it on the stories that matter to you; you can read one, create one, or **start** one. Starting does the Shortcut-side bookkeeping (start state, you as an owner, the current iteration) and then hands the branch and a first prompt to a **launcher**: Herdr's shipped worktree dialog, or a mod that takes the launch contract (the `projects` mod does). The mod finds and starts; it never decides how the work area is built or which agent runs.

Look and keyboard model are ported from [herdr-linear](https://github.com/mrolafsson/herdr-linear) (MIT, see `LICENSE-herdr-linear`).

## What you see

A popup at the top of the window, 40px down, 80% wide and 80% high, in herdr-linear's look (`JetBrains Mono` keys, tone chips, the same icon set). State colors come from the state's type, since Shortcut states carry none here: backlog grey, unstarted blue, started yellow, done green. Every screen has a line of keycap hints along the bottom; they are clickable.

- **list.** A top bar with four tabs and a filter box.
  - **Mine**: stories you own that are unstarted or started, grouped by state in workflow order.
  - **Team**: started stories of your team; a chooser row when you are in several teams.
  - **Epics**: open epics; Enter drills into an epic's stories.
  - **Recent**: the last 30 stories you started or opened (archived ones greyed).
  - Rows: state icon, `sc-1234`, name, chips for epic, iteration, labels, PR count, and the priority value when a priority field is set. The PR count shows only on stories fetched in full (a key lookup, Recent for stories not in another list): Shortcut's search answers with slim stories, which carry no pull requests.
  - The filter narrows by text. A story key (`sc-1234`, `#1234` or `1234`) is also looked up across the whole workspace and offered as the first row.
  - It draws from the cache at once and refreshes in the background (lists after 60 s, reference data after 10 min). Offline it keeps the cache and says so.
- **story.** Title, key, the story's link, the description as plain text, and a sidebar: state (menu), owners, requester, team, epic, iteration, labels, estimate, deadline, priority (menu, when configured), branches and pull requests.
- **create.** Name (required), description, then chips for team (your first), workflow state (the team's workflow's first unstarted state), type (feature/bug/chore), epic, iteration, owner (you, toggle) and priority (when configured). On success the new story's screen opens.
- **settings.** One row per setting, saved on every change (debounced), with "Saved" or the write error. See Settings below.
- **pickState.** Shown when you start a story whose workflow has no start state yet: "sc-1234 is in the ‹workflow› workflow, which has no start state yet. Pick one:" and the workflow's unstarted and started states, the first started one highlighted. The choice is saved and the start goes on.
- **signIn.** Shown when no token resolves or Shortcut answers 401. It explains the two ways to give a token and has an Open settings button.

## Keys

Bound in `keys.json` (merged into `~/.config/herdr-app/keys.json`):

| Key | Command | What |
|---|---|---|
| `cmd-alt-s` (global) | `mod.open:shortcut` | open or close the popup |
| `escape` (in the popup) | `shortcut.escape` | back, clear the filter, or close |
| `tab` / `shift-tab` (in the popup) | `shortcut.tab` / `shortcut.backtab` | next / previous tab, or field |

Without the `mod:shortcut` section Herdr closes the popup on Esc itself and the popup never sees Esc or Tab.

Handled by the popup itself, per screen:

- **list**: `↑ ↓` move, `PageUp/PageDown` jump, `← →` step, Enter opens (or drills into an epic), `s` start, `n` new story, `o` open in Shortcut, `/` filter, `r` refresh, `,` settings, `1`-`4` tabs, Esc clears the filter, then closes. Letters act only when the filter does not have the keyboard.
- **story**: `s` start, `t` state menu, `p` priority menu (when configured), `o` open in the browser, `y` copy the key, `b` copy the branch, `↑ ↓` pick a pull request, Enter opens it, `g` opens it in the `github` mod, Esc back.
- **menus** (state, priority, branch, pickState): `↑ ↓` choose, Enter set, Esc cancel (on pickState or the branch menu, Esc cancels the start: nothing more is written).
- **create**: ctrl+Enter create, Tab next field, Esc back.
- **settings**: Tab / shift-Tab next / previous field, Esc back.
- **signIn**: `,` settings, Esc close.

## Settings

Kept in `~/.config/herdr-app/data/shortcut.json`. A missing or broken file gives the defaults (a broken one shows its error, by position only, on the settings screen); unknown keys are dropped on save.

```jsonc
{
  "auth": { "env": "SHORTCUT_API_TOKEN" },          // or { "token": "…" }
  "startPrompt": "Read the shortcut story {id} for context, then suggest how to proceed.",
  "branchTemplate": "{mention}/sc-{number}/{slug}",
  "startStates": { "500000011": 500000013 },        // workflow id → state id
  "iteration": "current-if-unset",                   // or "never"
  "priorityField": null,                             // custom field id, or null
  "launcher": { "kind": "shipped" },                  // or { "kind": "mod", "name": "projects" }
  "recent": [ { "id": 1234, "at": "2026-11-04T…" } ]  // newest first, at most 30
}
```

- **auth.** `token` wins when present. Otherwise `env` names a variable, read each time the popup opens through your own shell, interactive and login (`$SHELL -ilc`), so a variable exported in `.zshrc` is found. The app's own environment does not have it, and `sh -lc` would read only `.profile`. What the shell's startup files print is ignored. The name must match `^[A-Za-z_][A-Za-z0-9_]*$` and is never echoed. A pasted token is saved here and the file is set to mode 600. The settings screen shows it as `••••` plus its last four characters, with Clear; it never shows the whole value again. Test calls `GET /member` and shows your name or the error. The token is sent in one header and never logged or cached.
- **startPrompt.** The agent's first message, given to the launcher. Empty means no prompt.
- **branchTemplate.** A live preview shows it for a sample story. A result `git check-ref-format --branch` rejects stops the start and points here.
- Template variables: `{id}` `sc-1234`, `{number}` `1234`, `{slug}` the name lowercased and dashed (48 chars at most), `{title}` the name, `{url}` the story link, `{mention}` your mention name, `{branch}` (prompt only) the chosen branch. Unknown `{…}` stay as typed.
- **startStates.** Per workflow, the state a story moves to on start (only unstarted and started states are offered). Unset workflows are marked; the first start in one asks (pickState). A configured state that no longer exists is dropped and asked again.
- **iteration.** `current-if-unset`: a story without an iteration gets the one started iteration that fits its team (or has no teams). None or several fitting: left alone, and the start says why. `never`: never touched.
- **priorityField.** An enabled custom field with values. Its value shows on rows and `p` sets it on a story.
- **launcher.** What opens the work area. See below.
- **recent.** Written by the popup.

### The launcher

- **Shipped worktree dialog** (`{ "kind": "shipped" }`). Opens Herdr's own worktree dialog with the selected space's folder and the branch. Select a space in the repo first: without one, or outside a git repo, the start is refused before anything is changed on Shortcut. It makes the worktree and a space with a shell. There is no agent, and the prompt is dropped. If a `projects` entry has auto-layout on for that repo, its watcher builds the tabs afterwards.
- **A mod** (`{ "kind": "mod", "name": "projects" }`). Opens that mod as a dialog with the launch request (`props.launch`, contract v1) and a `backTo` that returns to the story. The settings menu lists every folder under `~/.config/herdr-app/mods` with a `main.js`. A missing mod refuses the start ("launcher ‹name› is not installed") and does not fall back.
  - The `projects` mod needs its launch-by-props version (`~/gitprojects/herdr-projects`, merged). It matches the repo hints to a project and opens its launch screen with the branch and prompt filled in. You press Enter there.
  - What the request holds and what a launcher must do: see [Launch from another mod](../herdr-projects/README.md#launch-from-another-mod) in the projects README, and section 7 of `docs/superpowers/specs/2026-11-04-shortcut-mod-design.md`.

## Starting a story

1. The story is fetched fresh, and the launcher is checked (installed mod, or a selected space in a git repo).
2. Done or archived stories are refused: "sc-1234 is done. Follow-up work belongs in a new story."
3. The update holds only what changes:
   - The start state, only from a backlog or unstarted state, and only when it comes after the story's state in the workflow (never backwards). Otherwise the story keeps its state ("state kept: ‹name›").
   - You appended to the owners, if you are not there yet. Nobody is ever removed.
   - The iteration, per the setting.
4. A branch from the template is checked (`git check-ref-format --branch`) before anything is written: an invalid one refuses the start and points at settings, with the ticket untouched.
5. Nothing to change means no request. A rejected update is shown, and nothing is launched.
6. The branch: an open PR's branch, else a story branch (`checkout: "existing"`), else the template (`"new"`). Several at the same level are asked about.
7. The story goes to Recent (best effort: a failed save adds the note "recent not saved" and the start goes on), the launcher opens, and the popup closes. Any notes are shown for 1.5 s first.
8. Anything that stops the start after the update (Esc on the branch menu, a launcher error) starts with "sc-1234 was updated in Shortcut; ": press `s` again to resume.

## Install

Symlink (development, edits in the repo are live after the popup reopens):

```bash
ln -s ~/gitprojects/herdr-shortcut/mods/shortcut ~/.config/herdr-app/mods/shortcut
```

Copy (plain install, repeat after each update):

```bash
cp -R ~/gitprojects/herdr-shortcut/mods/shortcut ~/.config/herdr-app/mods/shortcut
```

Then:

1. Merge `keys.json` into `~/.config/herdr-app/keys.json`. Add `"cmd-alt-s": "mod.open:shortcut"` to `global` (check it is free first) and the whole `"mod:shortcut"` section. Keep the rest of the file as it is.
2. `herdr-app check ~/.config/herdr-app/mods/shortcut` must print no errors.
3. Note the change in `~/.config/herdr-app/CUSTOMIZATIONS.md`.
4. First run: `cmd-alt-s`. With `SHORTCUT_API_TOKEN` exported in your login shell, Mine shows your stories. Otherwise you get signIn: `,` opens settings, where you set the variable name or paste a token under Auth, then Test.
5. In settings, choose the launcher. Set start states now, or let the first start in each workflow ask.

Data files: `data/shortcut.json` (settings, and the token when pasted, mode 600) and `data/shortcut-cache.json` (API cache; safe to delete).

## Tests

```bash
node --test test/*.test.mjs
```

They run with a fake `herdr` module and a fake `fetch`; nothing reaches Shortcut.

## Watch out

- The shipped dialog checks out a local branch by name. It cannot fetch a remote-only branch: the start says "the shipped dialog can't fetch a remote-only branch" when a reused branch is not local. Use the projects launcher for PR branches.
- Done and archived stories are refused ("sc-1234 is archived."). Starting an already-started story is allowed and is how you resume: the state is kept and the existing branch is reused.
- The start's notes (state kept, iteration not set, the launcher's note) show for 1.5 s, then the popup closes. The launcher dialog stays open.
- `herdr-app check` runs the view's `init`, in a host without `structuredClone` (and other newer globals). Code that runs at init must not rely on them.
- The popup cancels its tasks when it closes. A start that is still running when you press Esc may stop between the Shortcut update and the hand-off.
- Members are not fetched: owners other than you are shown by count.
- 429: the client waits for `Retry-After` once, then shows the error. It never retries in a loop.
- `POST /stories/search` (v3) answers with the whole list as a plain array, no paging, and its stories are the slim kind: no pull requests or branches. Starting and the story screen fetch the full story.
- `herdr-app shot` returns the last frame the window drew. While the screen is locked or the display is asleep the window draws nothing, so shots are stale (the mod still runs: `herdr-app status` and the cache file show it).
- Local only: `machine` is always null.

## Follow-ups

1. Fork the installed `github` mod so a picked PR goes to the same launcher (`checkout: "existing"`, its review prompt, `source.kind: "github"`) instead of making its own worktree.
2. A prompt relay for the shipped path: leave `{ branch, prompt, source }` in shared state for the projects watcher to type into the space it builds.
3. Multiple machines (`machine` in the contract and in the shipped dialog's props).
4. A settings mapping from Shortcut team, epic or label to a project name, so `launch.repo.names` is filled on first starts.
