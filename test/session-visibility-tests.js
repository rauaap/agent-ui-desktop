import assert from 'node:assert/strict';
import { oldestSessionDays, sessionVisible, SessionVisibility } from '../js/session-visibility.js';
import { Sidebar } from '../js/sidebar.js';

const now = Date.parse('2026-06-20T12:00:00Z');
const day = 86_400_000;
const session = (age, name = 'Ancient notes') => ({
  id: '1', project_id: 'p', name, last_active_at: new Date(now - age * day).toISOString(),
});
assert.equal(oldestSessionDays([], now), 1);
assert.equal(oldestSessionDays([session(2.1)], now), 3);
assert.throws(() => oldestSessionDays([{ last_active_at: 'broken' }], now));
assert.equal(sessionVisible(session(2), 2, '', now), true);
assert.equal(sessionVisible(session(2.001), 2, '', now), false);
assert.equal(sessionVisible(session(100), null, '', now), true);
assert.equal(sessionVisible(session(100), 2, 'ancient', now), true);
assert.equal(sessionVisible(session(100), 2, '1', now), false);

const originalNow = Date.now;
Date.now = () => now;
const sidebar = Object.create(Sidebar.prototype);
sidebar.projects = [{ id: 'p', name: 'Project', path: '/project' }];
sidebar.sessions = [session(100)];
sidebar.ageDays = 2;
sidebar.query = 'project';
assert.equal(sidebar.groups()[0].sessions.length, 0);
sidebar.query = 'ancient';
assert.equal(sidebar.groups()[0].sessions.length, 1);
sidebar.query = '';
assert.equal(sidebar.groups()[0].sessions.length, 0);
let renders = 0;
sidebar.render = () => renders++;
sidebar.setSessions(sidebar.sessions);
assert.equal(renders, 1, 'unchanged catalog still re-evaluates elapsed time');

class Input {
  constructor() {
    this.listeners = {};
    this.value = '1';
    this.validity = { valid: true };
    this.style = { setProperty: (key, value) => { this[key] = value; } };
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  fire(type) { this.listeners[type]?.({ key: 'Enter', preventDefault() {} }); }
}
const originalDocument = globalThis.document;
globalThis.document = { activeElement: null };
try {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const toggle = new Input(), slider = new Input(), number = new Input();
  let cutoff;
  const controls = new SessionVisibility(toggle, slider, number, (value) => { cutoff = value; }, storage);
  assert.equal(toggle.disabled, true);
  assert.equal(controls.updateCatalog([session(10)]), null);
  assert.equal(number.value, '10');
  assert.equal(slider.disabled, true);
  toggle.checked = true;
  toggle.fire('change');
  assert.equal(cutoff, 10);
  slider.value = '3';
  slider.fire('input');
  assert.equal(number.value, '3');
  assert.equal(cutoff, 3);
  number.value = '2';
  number.fire('input');
  assert.equal(slider.value, '2');
  number.value = '';
  number.fire('input');
  assert.equal(cutoff, 2);
  globalThis.document.activeElement = number;
  controls.updateCatalog([session(5)]);
  assert.equal(number.value, '', 'poll preserves in-progress edit');
  number.fire('blur');
  assert.equal(number.value, '2');
  number.value = '1.5';
  number.fire('input');
  assert.equal(cutoff, 2);
  number.fire('blur');
  toggle.checked = false;
  toggle.fire('change');
  assert.equal(cutoff, null);
  assert.equal(controls.state.days, 2);
  const restored = new SessionVisibility(new Input(), new Input(), new Input(), () => {}, storage);
  assert.equal(restored.state.days, 2);
  assert.equal(restored.state.enabled, false);
  globalThis.document.activeElement = null;
  controls.updateCatalog([session(0.5)]);
  assert.equal(number.value, '1');
  assert.equal(controls.state.days, 1);
  assert.throws(() => new SessionVisibility(new Input(), new Input(), new Input(), () => {}, {
    getItem: () => '{"enabled":true,"days":0}',
  }));
} finally {
  Date.now = originalNow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
console.log('Session visibility tests passed');
