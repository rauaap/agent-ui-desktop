/** Missing worktrees are visible on session rows: node test/sidebar-missing-tests.js */
import assert from 'node:assert/strict';
import { Sidebar } from '../js/sidebar.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener() {}
}
const original = globalThis.document;
globalThis.document = { createElement: (tag) => new Node(tag) };
try {
  const sidebar = Object.create(Sidebar.prototype);
  sidebar.activeId = null;
  sidebar.selectedIds = new Set();
  sidebar.agents = [];
  sidebar.worktrees = new Map([['7', { id: '7', exists: false, branch: 'fix' }]]);
  sidebar.directoryExistence = { '/project-fix': false };
  sidebar.gear = () => new Node('span');
  const project = { id: '1', path: '/project' };
  const session = { id: '10', name: 'Session', worktree_id: '7', working_dir: '/project-fix' };
  const missing = (row) => row.children.filter((node) => node.className === 'missing');

  for (const archived of [false, true]) {
    const row = sidebar.sessionRow(session, project, archived);
    assert.equal(missing(row).length, 1);
    assert.equal(missing(row)[0].textContent, 'MISSING');
    assert.ok(row.children.some((node) => node.className === 'wt' && node.textContent === 'WT'));
    assert.match(row.title, /the directory is missing/);
  }
  for (const exists of [true, undefined]) {
    sidebar.directoryExistence = exists === undefined ? {} : { '/project-fix': exists };
    assert.equal(missing(sidebar.sessionRow(session, project, false)).length, 0);
  }
  sidebar.directoryExistence = {};
  sidebar.worktrees.clear();
  assert.equal(missing(sidebar.sessionRow(session, project, false)).length, 0);
  for (const working_dir of ['/project', '/project-fix']) {
    assert.equal(missing(sidebar.sessionRow({ ...session, worktree_id: null, working_dir }, project, false)).length, 0);
  }
  console.log('Sidebar missing worktree badges passed');
} finally {
  if (original === undefined) delete globalThis.document; else globalThis.document = original;
}
