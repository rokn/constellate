# Codeflight

Open a repository on your machine and fly through it. The codebase becomes a 3D map:
files are bodies sized by length and coloured by territory, imports are routes between
them, and a navigator — Claude, via the Agent SDK — reads the code and charts what the
directory tree can't tell you: the logical modules, how they talk at runtime, and where
the interesting parts are. Ask it anything and it builds the answer on screen: verbatim
code excerpts, static and runtime dependency diagrams, and custom visualizations it
writes for the question. Talk to it, if you like; the voice flies you around.

## Setup

```bash
npm install
npm run dev -- ~/code/some-repo     # http://localhost:4317
```

Or start without a path and pick one on the landing page.

The navigator runs through the Claude Agent SDK, which uses your Claude Code login (or
`ANTHROPIC_API_KEY` if set) — no separate key is needed if `claude` works in your terminal.
Voice is optional: put `INWORLD_API_KEY` in `.env` (see `.env.example`).

## What happens when you open a repo

1. **Scan (seconds, no model).** `git ls-files`, then every source file is read for its size,
   symbols, and imports, resolved to real paths — relative imports, tsconfig `paths`,
   workspace packages, Python packages, Go modules (every `go.mod`, nested modules
   included; a package import points at the file named for the package), Rust
   `mod`/`use`, JVM imports, C includes. The map appears and you fall into it from deep space.
2. **Intro (about a minute).** The navigator gets a digest of the scan plus README and
   manifests, reads the handful of files that matter — each one lights up on the map as it's
   read — and publishes the overview: a headline, 4–9 logical modules (amber beacons tethered
   to their files), the runtime links between them (amber arcs), and topics worth a visit.
   The overview is cached per commit in `.cache/`, so reopening is instant.
3. **Explore.** Take the tour, pick a destination, click anything, or ask.

## Go: VS Code's editor with gopls

Go files open in Monaco — the editor inside VS Code — with **gopls**, Go's language server,
behind it, so navigation is the compiler's, not a guess:

- **⌘/Ctrl-click** a name: go to its definition. Another repo file opens in the panel and
  the map flies there (Back with `[` retraces it); a jump into the standard library or the
  module cache opens read-only in place, with a way back.
- **⇧F12 or right-click → references**: the peek view lists every usage, and the files that
  use it light up on the map as a constellation.
- **Hover** for types and docs; also go-to-implementation, find, folding, sticky scroll.

The server starts gopls for the open repo on first use (every `go.mod` becomes a workspace
folder) and stops it when you switch repos. It needs `gopls` on your PATH or in
`$(go env GOPATH)/bin` (`go install golang.org/x/tools/gopls@latest`); without it, Go files
use the plain viewer. Monaco is loaded only when a Go file opens.

## Shaping the map

**Filter** (`f`) narrows the map to what you care about: include/exclude globs
(`internal/**`, `*.pb.go`) or plain words (`auth`), hide tests, hide docs and config, and
pick languages or top-level folders. Everything else leaves the graph and what remains
re-lays itself out into the freed space. The navigator can filter too (“only show me the
payment path”) — it picks the exact files by reading — and so can the voice, instantly,
by pattern.

**Organize by** changes what the map is clustered around. *Folders* is the repo as
stored. *Modules* is the intro's logical map. *New grouping…* asks the navigator for any
other cut — by architectural layer, by feature, by service, by data flow — and it
publishes a lens: named groups with the relationships between them. Files physically
flow into the new clusters, coloured by group, with a legend you can click to fly to a
group. Lenses are kept with the repo, and the voice can switch between them.

**Groups** (`g`) mark a set of files *on top of* whatever organization the map is in — a
coloured beacon floats at the centre of its files with spokes out to each one, and nothing
moves. Click a group's beacon on the map to fly to it. Make one from what's in focus, from what the
filter shows, from path patterns, or by asking the navigator ("mark the path of a message from channel to reply" — it reads, then
marks numbered stops). Toggle, fly to, or remove them in the panel; they're kept with the repo.

## Tuning

**Tune** (`,`) opens every knob on the map: glow (bloom strength, spread, threshold),
bodies (size, size by length, brightness, how dim unfocused files go, beacons), links
(opacities, widths, runtime arc, particles, group spokes), layout forces (repulsion, folder
and import pull and spacing, group tightness, radius and separation, runtime pull,
friction, settle time, freeze), camera (orbit/zoom/pan speed, glide, zoom-to-pointer,
flight time, focus distance, drift), labels, and the background and course line. Presets:
Default, Neon, Calm, Spread out, Dense, No glow. Changes apply live — force changes
reheat the layout so you watch it respond.

## What's saved, per repo

Everything lives in `.cache/<hash of the repo path>.json`: the overview, groupings, groups,
answers, and your view — knobs, layers, organize-by choice and filter — so each repo opens
the way you left it. A repo you haven't opened before starts from the knobs you last used.
When the repo's commit moves on, nothing is discarded: the map is marked stale and offers to
re-chart the overview, which replaces only the overview.

## How it's built

```
Browser ──SSE /api/events──── session state (overview, frames, activity, UI commands)
   │   ──HTTP /api/*────────── ask, file, graph, open
   │                                 │
   │                                 └── navigator (Claude Agent SDK, read-only)
   │                                        Read / Grep / Glob  +  "flight" MCP tools
   │
   └──WS /api/voice──── Inworld realtime  (navigation tools only)
                           └── ask_navigator ──> same navigator, in-process
```

**One author, one pilot.** The navigator (`server/navigator.ts`) is the only thing that
generates. It's Claude Code via the Agent SDK with built-in tools limited to Read, Grep and
Glob, `permissionMode: "dontAsk"` and no filesystem settings loaded (so an opened repo's
own `.claude` hooks never run). It reaches the screen through an in-process MCP server of
flight tools: `show_code` (the range is chosen by the model, the text is sliced from the
file server-side), `show_diagram` (static or logical layer), `show_custom` (HTML for a
sandboxed iframe), `show_text`, `focus` and `open_file` (camera), `deps`/`outline` (instant
static-graph queries), and `set_overview` during the intro. Follow-ups resume the same
Agent SDK session, so it remembers what it has read.

The voice (`server/voice.ts`) is Inworld's realtime API with tools that only move things:
`fly_to`, `open_file`, `focus_module`, `overview`, `back`, `show_frame`, `highlight`,
`set_layer`, `start_tour`. Anything that needs reading or drawing goes through
`ask_navigator` (or `focus_topic`), which returns immediately so the conversation never
stalls; the answer is injected as a new turn when the navigator finishes, and the voice
points at the views as it explains them. Everything runs in one Node process, so the
bridge calls the navigator directly.

**Custom visualizations** run in an iframe with `sandbox="allow-scripts"` (opaque origin —
no access to the page, storage or API) and a CSP that only allows d3 from jsdelivr. The
theme's colours are injected as CSS variables, and any element with `data-path`
(and optional `data-line`) flies you to that code when clicked.

## The map's colour grammar

| Colour | Means |
| --- | --- |
| cyan | a static import route |
| amber | a logical module and its runtime links |
| magenta | your course — the open file's halo, the focus, and the dashed line of where you've flown |

## Controls

| Key | Action | Say instead |
| --- | --- | --- |
| `/` or `⌘K` | ask, or type a file/symbol/module to jump | just talk |
| `f` | filter panel | "only show the Go code without tests" |
| `g` | groups panel | "mark everything under internal/billing" |
| `Space` | recenter on what's selected — the open file, else the focus, else the whole map | — |
| `,` | tune panel | — |
| `o` | overview | "zoom out" |
| `[` / `]`, mouse back / forward | back and forward through what you've opened | "go back" |
| `t` | guided tour of the modules | "give me the tour" |
| `i` / `l` | imports / runtime layer | "show the imports" |
| `v` | voice on/off | — |
| `Esc` | close the top thing | — |

Mouse: left-drag orbits, middle- or right-drag pans, and the wheel zooms toward the
pointer. Hover an import line for what it carries — which file imports which, on what
line, and the names it takes — and click it to open the import. Click a body to open the file (its imports and importers stay lit); click a
beacon to focus a module or group; click a directory point to focus everything under it.

## Layout

```
server/index.ts      one process: API, SSE stream, voice upgrade, Vite in dev
server/scan.ts       static scan: files, symbols, import extraction and resolution, digest
shared/filter.ts     map filters (globs, tests, docs, languages) — shared by browser, navigator, voice
server/session.ts    the session singleton, mutations, command queue, per-commit cache
server/navigator.ts  Claude Agent SDK: intro, asks, the flight MCP tools
server/voice.ts      Inworld realtime bridge and its navigation tools
server/repo.ts       contained file reads and verbatim slicing
shared/types.ts      every shape that crosses a process or model boundary
web/components/Space.tsx      the 3D map (3d-force-graph + bloom), flights, course line
web/components/Dossier.tsx    the navigator's answers and their views
web/components/FilePanel.tsx  source with imports / used-by / symbols
web/components/CommandBar.tsx jump-or-ask box
web/components/GoEditor.tsx   Monaco for Go files; providers and editor opener in web/lib/monaco.ts
web/components/MapControls.tsx organize-by switcher, filter, groups panel, legend
web/components/TuningPanel.tsx every map knob, with presets (web/lib/tuning.ts)
```

## Known limits

- Import resolution is pattern-based, not a compiler: dynamic requires, re-export barrels
  and unusual build aliases may be missed. Missed imports cost an edge on the map; the
  navigator's reading fills in logical structure either way.
- Repos past 3,500 files are trimmed (docs and config first); the count is shown.
- Each answer takes as long as Claude needs to read — usually 15–60 seconds. Activity
  streams meanwhile, and a new question supersedes the one in flight.
- Single user, single repo at a time, by design: it's a local tool.
