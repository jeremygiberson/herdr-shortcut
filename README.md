# herdr-shortcut

A Herdr app popup for Shortcut stories. It lists them, shows one, creates one, and starts one. A start moves the story to its start state, adds you as an owner and sets the current iteration. It then hands the branch and a first prompt to a configurable launcher: Herdr's shipped worktree dialog, or a mod such as `projects`. The mod finds and starts work. It never decides how the work area is built or which agent runs.

Install, every screen, every setting and the caveats are in [RECIPE.md](RECIPE.md).

## What you see

- **List**, with four tabs. Mine is your unstarted and started stories, grouped by state. Team is your team's started stories. Epics lists open epics, and you can drill into one. Recent is what you last started or opened. A filter narrows the list, and typing `sc-1234` finds any story in the workspace.
- **Story**: description, state, owners, epic, iteration, labels, priority, branches and pull requests. Menus change the state and the priority.
- **Create**: a new story without leaving the app.
- **Settings**: auth, start prompt, branch template, start state per workflow, iteration policy, priority field, launcher.
- **pickState** asks once for a workflow's start state. **signIn** appears when there is no token.

## Keys

`cmd-alt-s` opens the popup. Esc, Tab and shift-Tab go through the `mod:shortcut` section of `keys.json`, which must be merged. Inside the popup:

- `↑ ↓` move, Enter opens, `/` filter, `1`-`4` switch tabs.
- `s` start, `n` new story, `o` open in the browser, `r` refresh, `,` settings.
- On a story: `t` state menu, `p` priority menu, `y` copy the key, `b` copy the branch, `g` open the PR in the `github` mod.
- Esc goes back or closes.

## Settings

Settings live in `~/.config/herdr-app/data/shortcut.json` and are edited on the settings screen, which saves on change. The token comes from `$SHORTCUT_API_TOKEN` in your login shell by default. You can also paste it, and the file is then kept at mode 600 and the token is never shown again. The launcher is `{ "kind": "shipped" }` or `{ "kind": "mod", "name": "projects" }`. The full shape is in [RECIPE.md](RECIPE.md#settings).

## The launch contract

A mod launcher is opened as a dialog with `props.launch` (v1: `branch`, `checkout`, `prompt`, `source`, `repo` hints) and a `backTo`. The [projects README, "Launch from another mod"](../herdr-projects/README.md#launch-from-another-mod) documents it from the launcher's side. As the finder, this mod does all ticket-side work first and opens the launcher only when that succeeded. It passes nothing about agents, worktree roots, base branches or setup, and closes its own popup after the hand-off.

## Tests

```bash
node --test test/*.test.mjs
```

## License

MIT. The look (`look.js`), the icons and the keyboard model are ported from [herdr-linear](https://github.com/mrolafsson/herdr-linear) by mrolafsson, MIT; its license is kept in `LICENSE-herdr-linear`.
