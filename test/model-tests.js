import { normalizeAgents } from '../js/agents.js';
import {
  modelChoices, modelLabel, normalizeCatalog, pickModel, reasoningLabel, reasoningLevels,
} from '../js/models.js';
import { Store, reduce, toMarkdown } from '../js/store.js';

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
    models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', reasoning_levels: [] },
    ],
    models_error: null,
  },
  {
    id: 'pi', name: 'Pi', default: false,
    models: [{
      id: 'openai-codex/gpt-5.5', name: 'gpt-5.5',
      reasoning_levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    }],
    models_error: null,
  },
];
const m = (id, name = id) => ({ id, name, reasoning_levels: [] });
const agent = (id, models, error = null) => ({ id, name: id, default: false, models, models_error: error });

test('models: the documented catalog survives normalization unchanged', () => {
  equal(normalizeAgents(WIRE), WIRE);
});

test('models: ids stay opaque; unusable and duplicate rows are dropped', () => {
  equal(normalizeCatalog({
    models: [
      { id: ' spaced/id ', name: '', reasoning_levels: [] }, { id: '' }, { name: 'no id' }, null,
      { id: ' spaced/id ', name: 'dup' }, { id: 7, name: 'number' },
    ],
    models_error: null,
  }), { models: [{ id: ' spaced/id ', name: ' spaced/id ', reasoning_levels: [] }], models_error: null });
});

test('models: reasoning levels keep the harness order and vocabulary', () => {
  equal(normalizeCatalog({
    models: [{ id: 'x', name: 'X', reasoning_levels: ['max', 'off', '', 7, 'max', 'high'] }],
    models_error: null,
  }).models[0].reasoning_levels, ['max', 'off', 'high']);
});

test('models: a session offers its own model’s levels, and none once it is gone', () => {
  const agents = normalizeAgents(WIRE);
  equal(reasoningLevels(agents, 'claude-code', 'claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  equal(reasoningLevels(agents, 'claude-code', 'claude-haiku-4-5-20251001'), []);
  equal(reasoningLevels(agents, 'pi', 'claude-opus-5-5'), []);
  equal(reasoningLevels(agents, 'gone', 'x'), []);
  equal(reasoningLabel(null), 'Default');
  equal(reasoningLabel('xhigh'), 'xhigh');
});

test('models: reasoning_level events set the level, replay or not', () => {
  const state = { reasoningLevel: null };
  equal(reduce(state, { type: 'reasoning_level', reasoning_level: 'high' }), [{ op: 'meta' }]);
  equal(state.reasoningLevel, 'high');
  const store = new Store();
  store.setMeta('1', { reasoningLevel: 'low' });
  store.beginReplay('1');
  equal(store.replays.get('1').reasoningLevel, 'low');
  store.apply('1', { type: 'reasoning_level', reasoning_level: 'max' });
  equal(store.session('1').reasoningLevel, 'max');
  equal(store.replays.get('1').reasoningLevel, 'max');
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
  const pi = modelChoices(agent('pi', [m('b/two', 'two'), m('a/one', 'one')]));
  equal(pi.blocked, null);
  // Server order, no ranking.
  equal(pickModel(pi), 'b/two');
  equal(pickModel(modelChoices(normalizeAgents(WIRE)[0])), 'claude-opus-5-5');
});

test('models: every unusable catalog blocks with a reason and offers nothing', () => {
  const [pi, empty, blank] = normalizeAgents([
    agent('pi', [], 'boom'),
    agent('empty', []),
    agent('blank', [m('x')], ''),
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
