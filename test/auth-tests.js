/** Isolated transport/UI tests: node test/auth-tests.js (no real credentials/network). */
import assert from 'node:assert/strict';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.listeners = {}; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() {}
  focus() {}
}
class Socket {
  constructor(url) { this.url = url; this.listeners = {}; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  close() { this.closed = true; }
}
globalThis.WebSocket = Socket;
let saved = 'old-test-token-with-at-least-32-characters';
let reloads = 0;
let requests = [];
let response = 200;
globalThis.location = {
  protocol: 'http:', origin: 'http://server.test', search: '?api=http://attacker.test',
  reload: () => reloads++,
};
globalThis.localStorage = {
  getItem: () => saved,
  setItem: (key, value) => { assert.equal(key, 'agentUi.serverToken'); saved = value; },
};
globalThis.document = { body: new Element('body'), createElement: (tag) => new Element(tag) };
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  if (response === 'offline') throw new Error('network');
  return { status: response, ok: response === 200, text: async () => '[]' };
};
const auth = await import('../js/auth.js');
assert.equal(auth.httpBase, 'http://server.test');
const api = await import('../js/api.js');
await api.listAgents();
assert.equal(requests[0].url, 'http://server.test/agents');
assert.equal(requests[0].options.headers.get('Authorization'), `Bearer ${saved}`);
assert.equal(requests[0].options.redirect, 'error');

// WebSocket failure probes with the same credential; 200 keeps existing handling.
const socket = auth.authenticatedSocket('/ws/sessions/7?other=yes');
assert.equal(new URL(socket.url).searchParams.get('other'), 'yes');
socket.listeners.close();
await socket.authCheck;
assert.equal(auth.authBlocked(), false);
assert.equal(requests.at(-1).url, 'http://server.test/agents');
const files = auth.authenticatedSocket('/ws/sessions/7/files');
response = 401;
const realMockFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const result = await realMockFetch(...args);
  result.text = () => { throw new Error('Must not parse a 401 body'); };
  return result;
};
await assert.rejects(api.listAgents(), (error) => error.status === 401);
globalThis.fetch = realMockFetch;
assert.equal(files.closed, true);
assert.equal(auth.authBlocked(), true);
assert.equal(saved, 'old-test-token-with-at-least-32-characters');
const before = requests.length;
await assert.rejects(api.listAgents());
assert.equal(requests.length, before);
const form = document.body.children.at(-1).children[0];
const input = form.children.find((node) => node.tag === 'label').children[0];
const buttons = form.children.filter((node) => node.tag === 'button');
const anyway = buttons.find((node) => node.textContent === 'Save anyway');
const message = form.children.find((node) => node.listeners && node.tag === 'p' && !node.textContent);
const submit = () => form.onsubmit({ preventDefault() {} });
input.value = 'wrong';
await submit();
assert.equal(message.textContent, 'Token rejected');
assert.equal(anyway.hidden, true);
assert.equal(saved, 'old-test-token-with-at-least-32-characters');
response = 500;
await submit();
assert.equal(anyway.hidden, true);
response = 'offline';
await submit();
assert.equal(anyway.hidden, false);
input.value = 'changed';
input.oninput();
anyway.onclick();
assert.equal(reloads, 0);
response = 200;
input.value = '  replacement-test-token-with-+/=characters\n';
await submit();
assert.equal(saved, 'replacement-test-token-with-+/=characters');
assert.equal(reloads, 1);

const special = await import('../js/auth.js?special');
const specialSocket = special.authenticatedSocket('/ws/sessions/1/files');
assert.equal(new URL(specialSocket.url).searchParams.get('token'), saved);
response = 401;
specialSocket.listeners.close();
await specialSocket.authCheck;
assert.equal(special.authBlocked(), true);

// First run: opening the prompt must not make any requests.
saved = '';
const fresh = await import('../js/auth.js?fresh');
const count = requests.length;
assert.equal(fresh.authBlocked(), true);
fresh.showTokenPrompt();
assert.equal(requests.length, count);
assert.throws(() => fresh.authenticatedSocket('/ws/sessions/1'));
assert.equal(requests.length, count);

location.protocol = 'file:';
const disk = await import('../js/auth.js?disk');
assert.equal(disk.httpBase, 'http://attacker.test');
console.log('Auth transport and token-prompt tests passed.');
