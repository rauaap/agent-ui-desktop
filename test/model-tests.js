import { modelChoices, modelLabel, normalizeModels, pickModel } from '../js/models.js';
import { Store, toMarkdown } from '../js/store.js';

export const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const WIRE = {
  'claude-code': { models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }], error: null },
  pi: { models: [{ id: 'openai-codex/gpt-5.5', name: 'gpt-5.5' }], error: null },
};

test('models: the documented catalog survives normalization unchanged', () => {
  equal(normalizeModels(WIRE), WIRE);
});

test('models: ids stay opaque; unusable and duplicate rows are dropped', () => {
  equal(normalizeModels({
    pi: {
      models: [
        { id: ' spaced/id ', name: '' }, { id: '' }, { name: 'no id' }, null,
        { id: ' spaced/id ', name: 'dup' }, { id: 7, name: 'number' },
      ],
      error: null,
    },
  }), { pi: { models: [{ id: ' spaced/id ', name: ' spaced/id ' }], error: null } });
});

test('models: a failed catalog keeps its error and offers no models', () => {
  const catalogs = normalizeModels({
    ...WIRE,
    pi: { models: [], error: 'Model discovery timed out after 30 seconds' },
  });
  equal(catalogs.pi, { models: [], error: 'Model discovery timed out after 30 seconds' });
  // The other harness is untouched.
  equal(catalogs['claude-code'], WIRE['claude-code']);
});

test('models: malformed bodies normalize to no catalogs', () => {
  for (const body of [null, undefined, [], 'x', 3]) equal(normalizeModels(body), {});
  equal(normalizeModels({ pi: null, x: 'nope' }), {});
});

test('models: choices are scoped to the selected agent and preselect its first', () => {
  const catalogs = normalizeModels({
    ...WIRE,
    pi: { models: [{ id: 'b/two', name: 'two' }, { id: 'a/one', name: 'one' }], error: null },
  });
  const pi = modelChoices(catalogs, 'pi');
  equal(pi.blocked, null);
  // Server order, no ranking.
  equal(pickModel(pi), 'b/two');
  equal(pickModel(pi, 'a/one'), 'a/one');
  // An id from another agent's catalog is never kept.
  equal(pickModel(pi, 'claude-opus-5-5'), 'b/two');
  equal(pickModel(modelChoices(catalogs, 'claude-code')), 'claude-opus-5-5');
});

test('models: every unusable catalog blocks with a reason and offers nothing', () => {
  const catalogs = normalizeModels({
    ...WIRE,
    pi: { models: [], error: 'boom' },
    empty: { models: [], error: null },
    blank: { models: [{ id: 'x' }], error: '' },
  });
  const cases = [
    [modelChoices(new Error('Server error 404'), 'pi'), 'Model list unavailable: Server error 404'],
    [modelChoices(catalogs, 'unknown'), 'The server lists no models for this agent.'],
    [modelChoices(catalogs, 'pi'), 'Model list unavailable: boom'],
    [modelChoices(catalogs, 'empty'), 'The server found no models for this agent.'],
    // A present-but-empty error string still counts as a failure.
    [modelChoices(catalogs, 'blank'), 'Model list unavailable: Model discovery failed'],
    [modelChoices(null, 'pi'), 'Loading models…'],
  ];
  for (const [choice, reason] of cases) {
    equal(choice.blocked, reason);
    equal(pickModel(choice), null);
  }
  // Other agents stay usable.
  equal(modelChoices(catalogs, 'claude-code').blocked, null);
});

test('models: labels use the catalog name, fall back to the id, and legacy shows none', () => {
  const catalogs = normalizeModels(WIRE);
  equal(modelLabel(catalogs, 'claude-code', 'claude-opus-5-5'), 'Opus 5.5');
  equal(modelLabel(catalogs, 'claude-code', 'claude-opus-4-1'), 'claude-opus-4-1');
  equal(modelLabel(catalogs, 'pi', 'claude-opus-5-5'), 'claude-opus-5-5');
  equal(modelLabel(new Error('x'), 'pi', 'a/b'), 'a/b');
  equal(modelLabel(catalogs, 'pi', null), null);
  equal(modelLabel(catalogs, 'pi', undefined), null);
});

test('models: store keeps the session model through replay and export', () => {
  const store = new Store();
  equal(store.session('1').model, null);
  store.setMeta('1', { name: 'S', workingDir: '/p', agent: 'pi', model: 'openai-codex/gpt-5.5' });
  store.beginReplay('1');
  equal(store.replays.get('1').model, 'openai-codex/gpt-5.5');
  const markdown = toMarkdown(store.session('1'));
  if (!markdown.includes('`/p` · pi · openai-codex/gpt-5.5')) throw new Error(markdown);
  store.setMeta('2', { name: 'Legacy', workingDir: '/p', agent: 'pi', model: null });
  if (!toMarkdown(store.session('2')).includes('`/p` · pi\n')) throw new Error('legacy export changed');
});
