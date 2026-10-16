import assert from 'node:assert/strict';
import { sessionAgeStops, sessionVisible, SessionVisibility } from '../js/session-visibility.js';
import { Sidebar } from '../js/sidebar.js';

const now = Date.parse('2026-06-20T12:00:00Z');
const day = 86_400_000;
const session = (age, name = 'Ancient notes') => ({
  id: '1', project_id: 'p', name, last_active_at: new Date(now - age * day).toISOString(),
});
assert.deepEqual(sessionAgeStops(), [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90, null]);
assert.equal(sessionVisible(session(2), 2, '', now), true);
assert.equal(sessionVisible(session(2.001), 2, '', now), false);
assert.equal(sessionVisible(session(100), null, '', now), true);
assert.equal(sessionVisible(session(100), 2, 'ancient', now), true);
assert.equal(sessionVisible(session(100), 2, '1', now), false);
assert.equal(sessionVisible(session(101), 100, '', now), false);

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
    this.value = '';
    this.style = { setProperty: (key, value) => { this[key] = value; } };
  }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  fire(type, key = 'Enter') { this.listeners[type]?.({ key, preventDefault() {} }); }
}
const originalDocument = globalThis.document;
globalThis.document = { activeElement: null };
try {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const slider = new Input(), number = new Input();
  let cutoff;
  const controls = new SessionVisibility(slider, number, (value) => { cutoff = value; }, storage);
  assert.equal(controls.cutoff, null);
  assert.equal(number.value, '∞');
  assert.equal(slider.value, '11');
  assert.equal(slider.max, '11');
  number.fire('focus');
  assert.equal(number.value, '');
  number.fire('blur');
  assert.equal(number.value, '∞');

  for (const [index, days] of sessionAgeStops().entries()) {
    slider.value = String(index);
    slider.fire('input');
    assert.equal(controls.cutoff, days);
    assert.equal(number.value, days === null ? '∞' : String(days));
  }
  for (const [days, position] of [[10, 7], [14, 7], [20, 8], [45, 9], [90, 10], [100, 11], [1000, 11]]) {
    number.value = String(days);
    number.fire('input');
    assert.equal(cutoff, days);
    assert.equal(number.value, String(days));
    assert.equal(slider.value, String(position));
  }
  assert.equal(slider['aria-valuetext'], '1000 days; slider preset all sessions');
  slider.fire('click');
  assert.equal(cutoff, null, 'click on current final tick replaces exact value with infinity');
  assert.equal(number.value, '∞');
  number.value = '10';
  number.fire('input');
  slider.fire('click');
  assert.equal(cutoff, 14, 'click on current finite tick applies its preset');
  number.value = '100';
  number.fire('input');
  slider.fire('keyup', 'End');
  assert.equal(cutoff, null, 'End at the final tick selects infinity');

  number.value = '20';
  number.fire('input');
  for (const invalid of ['', '1.5', '0', '-1', 'bad', '1e2', '9007199254740992']) {
    number.value = invalid;
    number.fire('input');
    assert.equal(cutoff, 20);
    number.fire('blur');
    assert.equal(number.value, '20');
  }
  globalThis.document.activeElement = number;
  number.value = '';
  number.fire('input');
  controls.paint(true);
  assert.equal(number.value, '', 'refresh preserves in-progress edit');
  number.fire('blur');
  assert.equal(number.value, '20');
  number.value = '45';
  number.fire('keydown');
  assert.equal(cutoff, 45);
  const restored = new SessionVisibility(new Input(), new Input(), () => {}, storage);
  assert.equal(restored.cutoff, 45);
  slider.value = '11';
  slider.fire('click');
  const all = new SessionVisibility(new Input(), new Input(), () => {}, storage);
  assert.equal(all.cutoff, null);
  assert.equal(all.number.value, '∞');
  // Existing toggle preferences retain their meaning and are never catalog-clamped.
  for (const enabled of [true, false]) {
    const migrated = new SessionVisibility(new Input(), new Input(), () => {}, {
      getItem: () => JSON.stringify({ enabled, days: 119 }),
    });
    assert.equal(migrated.cutoff, enabled ? 119 : null);
    assert.equal(migrated.slider.value, '11');
  }
  assert.throws(() => new SessionVisibility(new Input(), new Input(), () => {}, {
    getItem: () => '{"enabled":true,"days":0}',
  }));
} finally {
  Date.now = originalNow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
console.log('Session visibility tests passed');
