/**
 * Everything the workshop can do in one go, by name: what a controller
 * button, a slice of the command wheel, the palm menu, a gesture you
 * recorded or a voice macro is bound to. The ids are what's kept (in Tune,
 * in a gesture, in a macro); the browser carries them out (web/board/actions.ts).
 */

export type BoardAction = { id: string; label: string; icon: string; hint: string; group: "panels" | "voice" | "history" | "tools" | "selection" | "room" | "boards" | "build" | "view" };

const a = (id: string, label: string, icon: string, group: BoardAction["group"], hint: string): BoardAction => ({ id, label, icon, group, hint });

export const BOARD_ACTIONS: BoardAction[] = [
  a("none", "Nothing", "close", "panels", "Does nothing"),
  // Panels.
  a("palette", "Palette", "build", "panels", "Components, holograms and templates"),
  a("tune", "Tune", "tune", "panels", "Every knob"),
  a("wheel", "Command wheel", "wheel", "panels", "The ring of quick actions"),
  a("shelf", "Board shelf", "shelf", "boards", "Every board, on a shelf beside you"),
  a("code", "Expand into code", "shelf", "boards", "The selected item's code in the Code view, filtered to it (the board's repo with nothing selected)"),
  a("snapshots", "Snapshot cards", "camera", "view", "The views you kept"),
  a("gestures", "Gestures", "hand", "panels", "Record a hand pose and bind it to an action"),
  // Voice.
  a("voice", "Voice on / off", "voice", "voice", "Talk to the assistant"),
  a("ask-selection", "Talk about this", "voice", "voice", "Voice on, with what you point at selected"),
  a("guide", "Guide", "help", "panels", "A tour of the controls you play through: controllers, hands, nesting, the room, the keyboard"),
  a("keymap", "Control map", "help", "panels", "Every button, slice, gesture and key, as they're set now"),
  a("transcript", "Transcript", "log", "voice", "Everything said, and what happened, on a panel you can pin"),
  a("keyboard", "Type", "label", "voice", "The text bar, for a keyboard: ask, label or note"),
  a("dictate", "Dictate", "mic", "voice", "Say the selected item's name or text"),
  // History.
  a("undo", "Undo", "undo", "history", "Undo the last change"),
  a("redo", "Redo", "redo", "history", "Redo"),
  a("scrub", "Scrub history", "clock", "history", "Twist your wrist to go back and forth through history"),
  a("save-version", "Save version", "pin", "history", "Keep the board as it is now"),
  // Tools.
  a("tool-select", "Select tool", "select", "tools", "Pick, move, carry"),
  a("tool-connect", "Connect tool", "connect", "tools", "Pull a link from one item to another"),
  a("tool-ink", "Ink tool", "ink", "tools", "Draw in the air"),
  a("tool-lasso", "Lasso tool", "lasso", "tools", "Sweep the ray across items to select them all"),
  a("tool-erase", "Eraser", "erase", "tools", "Sweep the ray across items to delete them all"),
  a("tool-cycle", "Next tool", "select", "tools", "Select → connect → ink → lasso → eraser"),
  a("two-hand-mode", "Stretch: scale / pull apart", "scale", "tools", "What two hands on one item do"),
  // Selection.
  a("delete-selection", "Delete selected", "trash", "selection", "Delete what's selected"),
  a("lock", "Lock / unlock items", "lock", "selection", "Freeze every item, so you only move the board"),
  a("deselect", "Deselect", "close", "selection", "Clear the selection"),
  a("duplicate", "Duplicate", "copy", "selection", "A copy of the selection beside it"),
  a("explode-toggle", "Pull apart / together", "explode", "selection", "The selected hologram, apart or back together"),
  a("spin-toggle", "Spin", "spin", "selection", "The selected hologram turns, or stops"),
  a("mark-done", "Mark done", "check", "selection", "The selection's status: done"),
  a("inside", "Go inside", "inside", "boards", "The selected item's own board"),
  a("up", "Go up", "up", "boards", "Back out to the board this one is inside"),
  a("clear-ink", "Clear ink", "erase", "selection", "Delete every ink stroke"),
  a("clear-notes", "Clear notes", "erase", "selection", "Delete every note"),
  a("clear-flags", "Clear review flags", "erase", "selection", "Take every review flag off"),
  // Room.
  a("recenter", "Reset the table", "table", "room", "The table back in front of you"),
  a("desk-mode", "Desk mode", "desk", "room", "Shrink the board onto your real desk"),
  a("wall-mode", "Wall mode", "wall", "room", "Stand the board up on a wall"),
  a("room-scale", "Room scale", "room", "room", "Blow the board up to the room and walk inside it"),
  a("table-mode", "Table mode", "table", "room", "Back to the holotable"),
  a("passthrough", "Passthrough on/off", "eye", "room", "See your room, or cover it with the virtual one (same session)"),
  a("exit", "Leave the headset", "exit", "room", "End the headset session, back to the page"),
  a("tiers", "Depth tiers", "tiers", "view", "Stack frames as floating tiers"),
  // Boards.
  a("next-board", "Next board", "next", "boards", "Switch to the next board"),
  a("prev-board", "Previous board", "prev", "boards", "Switch to the previous board"),
  a("place-board", "Board into the room", "room", "boards", "Stand this board in the room beside you and open the next"),
  // View.
  a("snapshot", "Take snapshot", "camera", "view", "Keep this view as a card"),
  a("labels-toggle", "Labels on / off", "label", "view", "Every label"),
  a("layers-reset", "Show everything", "eye", "view", "Clear hidden layers and isolation"),
  // Build.
  a("structure-sketch", "Sketch → structure", "build", "build", "Turn the ink into real blocks and links"),
  a("photo-import", "Photo → board", "camera", "build", "Photograph a whiteboard; it becomes a board"),
  a("repo-board", "Repo → board", "code", "build", "The open repo's architecture, on the board"),
  a("review", "Design review", "check", "build", "Flag the design's real issues"),
  a("export", "Export design doc", "copy", "build", "The board as a Markdown design doc (downloads on the desktop)"),
];

export const ACTION_IDS = BOARD_ACTIONS.map((x) => x.id);
export const actionById = (id: string) => BOARD_ACTIONS.find((x) => x.id === id);

/** An action by id or by its name as said ("save version", "undo"). */
export function findAction(name: string): BoardAction | undefined {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = plain(name);
  if (!p) return undefined;
  return BOARD_ACTIONS.find((x) => plain(x.id) === p) ?? BOARD_ACTIONS.find((x) => plain(x.label) === p) ?? BOARD_ACTIONS.find((x) => plain(x.label).includes(p) || plain(x.id).includes(p));
}
