import type { Item, ItemKind, Vec3 } from "../../shared/board";
import type { BoardClient } from "./client";

export type Tool = "select" | "connect" | "ink";

/** What the desktop and the headset can do to the board: implemented by the page. */
export interface Ctl {
  client: BoardClient;
  selected(): string[];
  select(ids: string[], additive?: boolean): void;
  tool(): Tool;
  setTool(t: Tool): void;
  add(kind: ItemKind, pos: Vec3, extra?: Partial<Item>): string;
  remove(ids: string[]): void;
  link(from: string, to: string): void;
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
}
