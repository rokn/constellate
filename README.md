# Constellate

Fly through a codebase as a 3D map. Files are bodies, imports are routes between them,
and a navigator (Claude, through the Agent SDK) reads the code, charts its modules, and
answers your questions on the map, out loud if you like.

![Constellate flying through its own repository](docs/constellate.gif)

## Install

```bash
npm install
npm run dev -- ~/code/some-repo     # http://localhost:4317
```

The navigator uses your Claude Code login, or `ANTHROPIC_API_KEY` if it's set. Voice is
optional: put `INWORLD_API_KEY` in `.env` (see `.env.example`).

For a build that doesn't watch: `npm run build && npm start -- ~/code/some-repo`.

### Docker

One container maps one repository, kept under `/data`:

```bash
docker run -p 4317:4317 -v constellate:/data \
  -e REPO_URL=https://github.com/you/repo.git -e GIT_TOKEN=… \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  ghcr.io/rokn/constellate
```

Or one container for any GitHub repo: set `CODEFLIGHT_REPOS_DIR=/data/repos` instead of `REPO_URL`. You give it a link or `owner/name` (on the start page, or "Switch repo" by the repo's name), and it clones it there and opens it. Repos you opened before stay cloned, and going back to one brings back its map, groupings, notes, answers and stories as you left them. After a restart it reopens the last one. `GIT_TOKEN` decides which private repos it can read.

It has no login of its own, so put it behind an authenticating proxy before exposing it.

## Shortcuts

| Key | |
| --- | --- |
| `/` or `⌘K` | Ask the navigator, or jump to a file, symbol or module |
| `Space` | Frame the selection: the file, then the file with its connections |
| `Esc` | Close the top thing, and last of all undo "show only" (modules you hid stay hidden) |
| `o` | Overview |
| `[` `]` | Back and forward through what you've opened |
| `f` / `m` | Filter / markers on the map |
| `h` | History: the map at each commit, `↑` `↓` to step |
| `a` | Answers so far |
| `n` | Note on the open file or hovered import |
| `s` | Stories |
| `t` | Guided tour of the modules |
| `i` / `l` | Imports / runtime layer |
| `x` | Hide the focused files |
| `u` | Hide the UI |
| `v` | Voice on or off |
| `,` | Tune the map |

**Mouse:** left-drag orbits, hold right-drag to fly, and the wheel zooms toward the
pointer. Click a file to select it and light its connections. In the module list, click
a dot to show only that module, Shift-click it to hide it, and double-click a module to
isolate it and fly to it. Hold Shift over a module to light where it connects.
