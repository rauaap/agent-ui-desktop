import { hasUnknownDirectories, withDirectoryExistence } from './directory-existence.js';

/** Read catalogs before filesystem state. Publish nothing until a round succeeds. */
export async function fetchCatalogSnapshot(api, { agents = [] } = {}) {
  for (let round = 0; round < 2; round++) {
    const [projects, sessions, worktrees, nextAgents] = await Promise.all([
      api.listProjects(),
      api.listSessions(),
      api.listWorktrees(),
      api.listAgents().catch(() => agents),
    ]);
    const existence = await api.getDirectoryExistence();
    // Concurrent mutations can introduce paths outside this snapshot. Retry once;
    // any still-absent keys stay unknown until the next periodic refresh.
    if (round === 0 && hasUnknownDirectories(existence, projects, sessions, worktrees)) continue;
    return {
      projects: withDirectoryExistence(projects, existence),
      sessions,
      worktrees: withDirectoryExistence(worktrees, existence),
      agents: nextAgents,
      existence,
    };
  }
}
