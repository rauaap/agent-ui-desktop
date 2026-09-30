import { normalizeAgents } from '../js/agents.js';
import { modelChoices, modelLabel, normalizeCatalog, pickModel } from '../js/models.js';
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

const WIRE = [
  {
    id: 'claude-code', name: 'Claude Code', default: true,
    models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }], models_error: null,
  },
  {
    id: 'pi', name: 'Pi', default: false,
    models: [{ id: 'openai-codex/gpt-5.5', name: 'gpt-5.5' }], models_error: null,
  },
];
const agent = (id, models, error = null) => ({ id, name: id, default: false, models, models_error: error });

test('models: the documented catalog survives normalization unchanged', () => {
  equal(normalizeAgents(WIRE), WIRE);
});

test('models: ids stay opaque; unusable and duplicate rows are dropped', () => {
  equal(normalizeCatalog({
    models: [
      { id: ' spaced/id ', name: '' }, { id: '' }, { name: 'no id' }, null,
      { id: ' spaced/id ', name: 'dup' }, { id: 7, name: 'number' },
    ],
    models_error: null,
  }), { models: [{ id: ' spaced/id ', name: ' spaced/id ' }], models_error: null });
});

test('models: a failed catalog keeps its error and offers no models', () => {
  const agents = normalizeAgents([
    WIRE[0],
    { ...WIRE[1], models: [], models_error: 'Model discovery timed out after 30 seconds' },
  ]);
  equal(agents[1].models, []);
  equal(agents[1].models_error, 'Model discovery timed out after 30 seconds');
  // The other harness is untouched.
  equal(agents[0], WIRE[0]);
});

test('models: choices are scoped to the selected agent and preselect its first', () => {
  const pi = modelChoices(agent('pi', [{ id: 'b/two', name: 'two' }, { id: 'a/one', name: 'one' }]));
  equal(pi.blocked, null);
  // Server order, no ranking.
  equal(pickModel(pi), 'b/two');
  equal(pickModel(modelChoices(normalizeAgents(WIRE)[0])), 'claude-opus-5-5');
});

test('models: every unusable catalog blocks with a reason and offers nothing', () => {
  const [pi, empty, blank] = normalizeAgents([
    agent('pi', [], 'boom'),
    agent('empty', []),
    agent('blank', [{ id: 'x' }], ''),
  ]);
  const cases = [
    [modelChoices(pi), 'Model list unavailable: boom'],
    [modelChoices(empty), 'The server found no models for this agent.'],
    // A present-but-empty error string still counts as a failure.
    [modelChoices(blank), 'Model list unavailable: Model discovery failed'],
  ];
  for (const [choice, reason] of cases) {
    equal(choice.blocked, reason);
    equal(pickModel(choice), null);
  }
});

test('models: labels use the catalog name, fall back to the id, and legacy shows none', () => {
  const agents = normalizeAgents(WIRE);
  equal(modelLabel(agents, 'claude-code', 'claude-opus-5-5'), 'Opus 5.5');
  equal(modelLabel(agents, 'claude-code', 'claude-opus-4-1'), 'claude-opus-4-1');
  equal(modelLabel(agents, 'pi', 'claude-opus-5-5'), 'claude-opus-5-5');
  equal(modelLabel(agents, 'gone', 'a/b'), 'a/b');
  equal(modelLabel(agents, 'pi', null), null);
  equal(modelLabel(agents, 'pi', undefined), null);
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
