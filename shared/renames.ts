import type { MapFilter } from "./types";

/**
 * Files git saw move between two commits, and the folders that moved whole.
 * Everything kept by path — groupings, notes, markers, what you hid — is
 * rewritten with it, so a rename doesn't strand them on a path that's gone.
 */
export type Renames = {
  files: [from: string, to: string][];
  /** Folders (no trailing slash) none of whose files stayed behind. */
  dirs: [from: string, to: string][];
};

/** Old path → new path; a path that didn't move comes back as it was. */
export function renamer(r: Renames): (p: string) => string {
  const files = new Map(r.files);
  // Deepest folder first, so a/b/ wins over a/.
  const dirs = [...r.dirs].sort((x, y) => y[0].length - x[0].length);
  return (p) => {
    const moved = files.get(p);
    if (moved) return moved;
    for (const [from, to] of dirs) {
      if (p === from) return to;
      if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
    }
    return p;
  };
}

/** The folders that moved, read off the files: a/b/c.ts → x/b/c.ts moved a/b to x/b and a to x. */
export function movedDirs(files: [string, string][], stillThere: (dir: string) => boolean): [string, string][] {
  const seen = new Map<string, string | null>();
  for (const [from, to] of files) {
    const a = from.split("/");
    const b = to.split("/");
    let i = a.length - 1;
    let j = b.length - 1;
    if (a[i] !== b[j]) continue; // renamed, not moved
    // Walk up while the names match: each folder on the way moved with it.
    while (i > 0 && j > 0) {
      const dirFrom = a.slice(0, i).join("/");
      const dirTo = b.slice(0, j).join("/");
      if (dirFrom === dirTo) break;
      const had = seen.get(dirFrom);
      // Two files from one folder that went to different places: it didn't move whole.
      seen.set(dirFrom, had === undefined || had === dirTo ? dirTo : null);
      if (a[i - 1] !== b[j - 1]) break;
      i--;
      j--;
    }
  }
  return [...seen].filter((e): e is [string, string] => e[1] !== null && !stillThere(e[0]));
}

const unique = (xs: string[]) => [...new Set(xs)];

/** A filter with its paths, hidden files and isolated folders and modules moved along. */
export function renameInFilter(f: MapFilter, to: (p: string) => string): MapFilter {
  return {
    ...f,
    paths: f.paths && unique(f.paths.map(to)),
    hidden: f.hidden && unique(f.hidden.map(to)),
    isolate: f.isolate?.map((i) =>
      i.kind === "dir"
        ? { ...i, id: to(i.id), label: i.id === "." ? i.label : `${to(i.id)}/` }
        : { ...i, paths: i.paths && unique(i.paths.map(to)) },
    ),
  };
}
