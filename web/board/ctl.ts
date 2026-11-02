import type { BoardSummary, Item, ItemKind, Link, Vec3 } from "../../shared/board";
import type { BoardClient } from "./client";

export type Tool = "select" | "connect" | "ink" | "lasso" | "erase";

/** What the desktop and the headset can do to the board: implemented by the page. */
export interface Ctl {
  client: BoardClient;
  selected(): string[];
  select(ids: string[], additive?: boolean): void;
  tool(): Tool;
  setTool(t: Tool): void;
  add(kind: ItemKind, pos: Vec3, extra?: Partial<Item>): string;
  remove(ids: string[]): void;
  link(from: string, to: string, extra?: Partial<Link>): void;
  /** Edit an item's words (desktop: a text box). */
  edit(id: string): void;
  toggleVoice(): void;
  voiceState(): string;
  /** What the voice is saying, or heard, right now. */
  caption(): string;
  ask(text: string): void;
  inkColor(): string;
  /** Into an item's own board; back up out of this one. */
  inside?(id: string): void;
  up?(): void;
  /** A link picked: its inspector. */
  selectLink?(id: string | null): void;
  /** Switch to another board (the scene, and a headset session, stay). */
  open?(boardId: string): void;
  /** Every board, newest first. */
  boards?(): BoardSummary[];
  /** Show a board that isn't live (history being scrubbed), or the live one again (null). */
  preview?(b: import("../../shared/board").Board | null, label?: string): void;
  /** Run a named action (shared/boardActions.ts). */
  run?(action: string, from?: "button" | "wheel" | "gesture" | "voice" | "dock"): void;
}
