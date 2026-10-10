/** Search keeps session creation available: node test/sidebar-search-tests.js */
import assert from 'node:assert/strict';
import { Sidebar } from '../js/sidebar.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
}
const original = globalThis.document;
globalThis.document = { createElement: (tag) => new Node(tag) };
try {
  const sidebar = Object.create(Sidebar.prototype);
  sidebar.root = new Node('nav');
  sidebar.query = 'search';
  sidebar.expanded = new Set();
  sidebar.searchCollapsed = new Set();
  sidebar.gear = () => new Node('span');
  sidebar.sessionRow = () => new Node('button');
  let createdFor;
  sidebar.handlers = { onNewSession: (project) => { createdFor = project; } };
  const project = { id: '1', name: 'Search project', path: '/project' };
  const group = { project, live: [{ id: '10', name: 'Search session' }], archived: [] };
  sidebar.renderProject(group, false);
  const list = sidebar.root.children[1];
  const add = list.children[0];
  assert.equal(add.textContent, '+  New session');
  assert.equal(list.children.length, 2);
  add.listeners.click();
  assert.equal(createdFor, project);
  sidebar.searchCollapsed.add('/project');
  sidebar.root = new Node('nav');
  sidebar.renderProject(group, false);
  assert.equal(sidebar.root.children.length, 1, 'collapsed search project has no session list');
  sidebar.searchCollapsed.delete('/project');
  sidebar.root = new Node('nav');
  sidebar.renderProject({ ...group, archived: group.live }, true);
  assert.ok(sidebar.root.children[1].children.every((node) => node.textContent !== '+  New session'));
  console.log('Sidebar search: New session remains available in live results, never in archive passed');
} finally {
  if (original === undefined) delete globalThis.document; else globalThis.document = original;
}
