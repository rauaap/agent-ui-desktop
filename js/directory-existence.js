/** Filesystem snapshots are separate from catalog/association state. */
export const directoryExists = (snapshot = {}, path) => Object.hasOwn(snapshot, path)
  ? snapshot[path] : undefined;

export function hasUnknownDirectories(snapshot, projects, sessions, worktrees) {
  return [...projects.map((row) => row.path), ...worktrees.map((row) => row.path),
    ...sessions.map((row) => row.working_dir)].some((path) => path
      && directoryExists(snapshot, path) === undefined);
}

/** Local presentation rows only: `exists` is not a server catalog field. */
export const withDirectoryExistence = (rows, snapshot) => rows.map((row) => ({
  ...row, exists: directoryExists(snapshot, row.path),
}));
