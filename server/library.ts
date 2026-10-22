import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryRepo } from "../shared/types";

/**
 * CODEFLIGHT_REPOS_DIR turns the server into a shelf of GitHub repos: you give
 * it one, it clones it there (as <owner>/<name>) and opens it, and the ones
 * you opened before stay cloned. Each repo's groupings, notes, answers and
 * stories are saved by its path like any other, so going back to one
 * restores it as you left it. Local paths can't be opened in this mode.
 */
export const REPOS_DIR = process.env.CODEFLIGHT_REPOS_DIR ? path.resolve(process.env.CODEFLIGHT_REPOS_DIR) : undefined;

/** When each repo was last opened, and which was open last (reopened on start). */
const SHELF_FILE = () => path.join(REPOS_DIR!, ".shelf.json");
type Shelf = { last?: string; opened: Record<string, number> };

async function loadShelf(): Promise<Shelf> {
  try {
    const s = JSON.parse(await readFile(SHELF_FILE(), "utf8")) as Shelf;
    return { last: s.last, opened: s.opened ?? {} };
  } catch {
    return { opened: {} };
  }
}

/** "owner/name" from a GitHub URL (https or ssh) or the bare "owner/name". */
export function parseGitHub(input: string): string | null {
  const s = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/.*)?$/.exec(s);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}

export const rootOf = (id: string) => path.join(REPOS_DIR!, ...id.split("/"));

const isRepo = (dir: string) =>
  stat(path.join(dir, ".git")).then(
    () => true,
    () => false,
  );

/** The cloned repos, most recently opened first. */
export async function listRepos(current: string | undefined, headline: (root: string) => Promise<string | undefined>): Promise<LibraryRepo[]> {
  const shelf = await loadShelf();
  const ids: string[] = [];
  for (const owner of await readdir(REPOS_DIR!).catch(() => [])) {
    if (owner.startsWith(".")) continue;
    for (const name of await readdir(path.join(REPOS_DIR!, owner)).catch(() => [])) {
      if (!name.endsWith(".partial") && (await isRepo(path.join(REPOS_DIR!, owner, name)))) ids.push(`${owner}/${name}`);
    }
  }
  const repos = await Promise.all(
    ids.map(async (id) => ({
      id,
      url: `https://github.com/${id}`,
      headline: await headline(rootOf(id)),
      openedAt: shelf.opened[id],
      current: rootOf(id) === current,
    })),
  );
  return repos.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || a.id.localeCompare(b.id));
}

/**
 * The repo's clone, cloned now if it isn't yet. Progress ("Receiving objects:
 * 45%") goes to `progress` as git reports it.
 */
export async function ensureClone(id: string, progress: (line: string) => void): Promise<string> {
  const root = rootOf(id);
  if (await isRepo(root)) return root;
  const partial = `${root}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(path.dirname(root), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const git = spawn("git", ["clone", "--progress", `https://github.com/${id}.git`, partial], {
      // Never stop to ask for a password: a repo the token can't read fails instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let tail = "";
    let shown = 0;
    git.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000);
      const line = tail.split(/[\r\n]/).filter(Boolean).pop();
      // git redraws its counters many times a second; a few a second is plenty.
      if (line && !line.startsWith("Cloning into") && Date.now() - shown > 400) {
        shown = Date.now();
        progress(line.trim());
      }
    });
    git.on("error", reject);
    git.on("close", (code) => {
      if (code === 0) return resolve();
      if (/not found|could not read|authentication|terminal prompts disabled/i.test(tail)) {
        return reject(new Error(`${id} isn't on GitHub, or this server's token can't read it.`));
      }
      const why = tail.split(/[\r\n]/).filter((l) => /fatal|error/i.test(l)).pop()?.replace(/^fatal:\s*/, "");
      reject(new Error(why ? `Couldn't clone ${id}: ${why}` : `Couldn't clone ${id} (git exited with ${code}).`));
    });
  }).catch(async (err) => {
    await rm(partial, { recursive: true, force: true });
    await dropEmptyOwner(id);
    throw err;
  });
  await rename(partial, root);
  return root;
}

export async function markOpened(id: string) {
  const shelf = await loadShelf();
  shelf.last = id;
  shelf.opened[id] = Date.now();
  await mkdir(REPOS_DIR!, { recursive: true });
  await writeFile(SHELF_FILE(), JSON.stringify(shelf));
}

export async function lastOpened(): Promise<string | undefined> {
  const { last } = await loadShelf();
  return last && (await isRepo(rootOf(last))) ? last : undefined;
}

/** Delete the clone. Its saved map is the caller's to drop. */
export async function removeClone(id: string) {
  await rm(rootOf(id), { recursive: true, force: true });
  const shelf = await loadShelf();
  delete shelf.opened[id];
  if (shelf.last === id) shelf.last = undefined;
  await writeFile(SHELF_FILE(), JSON.stringify(shelf));
  await dropEmptyOwner(id);
}

/** The owner's folder goes once none of its repos are left. */
async function dropEmptyOwner(id: string) {
  const owner = path.dirname(rootOf(id));
  if (!(await readdir(owner).catch(() => [""])).length) await rm(owner, { recursive: true, force: true });
}
