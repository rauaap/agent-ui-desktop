/** Raw strings only: expansion and validation belong to the server. */
export function sandboxPathEntries(rows) {
  return rows.map(({ path, write }) => {
    if (!path.trim()) throw new Error('Enter a path or remove the empty entry');
    return { path, write: write === true };
  });
}

export function isExactOverride(path, defaults) {
  return defaults.some((entry) => entry.path === path);
}
