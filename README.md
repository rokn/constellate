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

## Go apps

In a Go repository, **Organize by → Go apps** (on the desktop, in the headset's menu, or
"organize by Go apps" to the voice) turns each executable, every `package main`, into an
app. An app holds the packages only it imports, directly or through others; the packages
two or more apps import are the shared libraries between them, and the lines between
groups show which app imports which library. Packages no executable reaches gather under
"in no app". It's built from the imports alone, so it's there before the navigator has
charted anything, and it's rebuilt with every scan.

## Agents

Constellate can also change the code. Ask for it ("add retries to the uploader") by voice
or in the Ask box, or type a task in **Agents**, and a coding agent (Claude Code, through the Agent SDK) starts
on it in its own git worktree, on a branch of its own (`agent/<name>-<id>`) off the commit
you're looking at. Several can work at once. The files each one touches light up under
a marker as it goes, and when it finishes the voice tells you what it did. **Show on map**
(or "show me what it did") puts its branch on the map against where it started; you can
send it follow-ups, stop it, or discard it with its branch.

What it changed is committed to its branch when it stops. With `GIT_TOKEN` set, the
branch is then pushed and a pull request opened into the branch it started from (a
fine-grained token needs Contents and Pull requests read and write); follow-ups you send
it go to the same PR. **Merge** in the panel (or "merge it" to the voice, which asks
first, or typed in Ask, which puts a Merge button on the answer to press) rebase-merges
the PR on GitHub. Typed or spoken, questions still go to the navigator; the Ask box and
the voice share one set of agent tools (`server/actions.ts`). Without a token, nothing
leaves the box. When its base has moved on, **Rebase** (or "rebase it") fetches the base
branch and replays the agent's commits on top of it, pushing to its PR if it has one; if
they conflict, the branch is left as it was and you're told which files. In the headset,
the menu's **Agents** tab lists them, starts new ones, rebases them, and merges them
(press Merge twice).

An agent can read and edit files only inside its worktree, and has no
shell unless you turn one on (see `.env.example`). Worktrees live under the cache directory.

## In a headset

With a Meta Quest 3 (its browser), or a PC with Link or SteamVR connected, **VR** and
**Passthrough** buttons appear next to the voice button. Nothing else changes when there's
no headset. Go in and out freely: the open file, the focus, answers and stories carry
across both ways. In passthrough, Menu → **Place on a surface** puts the map on a table.
The headset anchors it there (and, where it can, keeps the anchor, so the next session
puts the map back on the same table) and finds the table's edges from the room's planes.
A strip of controls then lies along the edge nearest you, and a shelf along the right-hand
edge holds what you've taken off the map: throw a module away, or drop a dragged one on
the shelf, and it waits there, collapsed, until you press it to put it back.

WebXR needs a secure page. Over USB, run `adb reverse tcp:4317 tcp:4317` and open
`http://localhost:4317` on the Quest. Over Wi-Fi, put a [mkcert](https://github.com/FiloSottile/mkcert)
certificate for your LAN address in `.certs/codeflight.pem` and `.certs/codeflight-key.pem`,
and open `https://<your-LAN-address>:4443`.

| Quest controller | |
| --- | --- |
| Trigger, or pinch | Point and select (a module: its files and the links between them; again, with what they talk to); held and moved on a body, drag it (throw it to hide it, or grip before letting go to pin it there); on open sky, drag the map |
| Grip | Grab the map; both grips (or both hands pinching) to scale it and rotate it any way; on a panel or its handle, carry it (the stick pushes and pulls it; the other hand's grip on the code, answers or story panel resizes it) |
| Left stick · right stick | Fly where you point · turn ← → about what you're looking at, zoom ↑ ↓ (or push and pull a held body) |
| Right stick click | On a body, focus on it; again, a ring more of its connections (the bar over the dock widens and narrows it, and **Only these** hides the rest of the map) |
| A · B · X · Y | Menu · back · voice · the whole map |

| Hands | |
| --- | --- |
| Pinch | As the trigger: select; held on a body, drag it (throw it to hide it); on open sky, drag the map; both hands, scale and rotate it |
| Touch with a fingertip | Press any panel's buttons; with a pointing finger, touch a body to pick it |
| Pinch open sky, hold still, draw a loop | Light up the files inside the loop |
| Thumb on middle finger | Right hand: forward · left hand: back |
| Left palm up | A menu on your wrist, to touch with the other hand |
| Both hands in an L, framing | Light up what's in the frame (frame all of it for the whole map) |

A keyboard works in the headset too, in VR and passthrough (a Bluetooth one paired with
the Quest, or the PC's own over Link). **Enter** or **/** opens the room's keyboard to ask,
and while it's open you type into it: **Enter** sends, **Esc** closes. Otherwise the arrows
or **WASD** fly the way you're facing, **Q / E** (or Page Down / Up) sink and rise, and
**Shift** goes faster; other keys are the desktop's shortcuts.

The dock's **?** shows these in the headset, for what you're holding: controllers, hands, or both. **Tune** there holds every knob the desktop's
Tune panel has (the same settings, so changes carry across), plus the headset's own:
render resolution and bloom, how much of the room shows through in passthrough, a floor
grid in VR, turning and speeds, and the voice volume. Panels stay where you carry them;
Menu → **Recenter panels** brings them back in front of you.

History, branch view and custom views stay on the desktop for now.

## Shortcuts

| Key | |
| --- | --- |
| `/` or `⌘K` | Ask about the code or for a change, or jump to a file, symbol or module |
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

**Touch:** one finger orbits. Two fingers pinch to zoom toward your fingers, drag to pan, or
twist to spin the sky, whichever they start doing; they keep to it until they lift. Spread
two fingers on a module's beacon to show only that module, and pinch them shut on it to
bring the rest back. Press and hold on a file, a module or open sky for a ring
of actions (open, ask about it, note, show only, hide, the whole map…): slide to one and
lift, or lift in the middle and tap one. Double-tap open sky to see the whole map. Swipe
with three fingers: sideways for back and forward, down for the whole map, up to hide the
controls. "Tilt to look", in the ring on open sky, turns the view as you turn the tablet,
and laying the tablet flat on a table shows the whole map from above. With History or a
story open, slide your thumb along the bottom edge to scrub through it. On Android you feel
a tick for each commit or beat you scrub past, each module you fly into, and the
navigator's arrivals.
