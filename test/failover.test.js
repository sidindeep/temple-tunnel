const test = require('node:test');
const assert = require('node:assert/strict');
const { findNextServer } = require('../src/failover');

const servers = [
  { id: 'one', supported: true },
  { id: 'two', supported: false },
  { id: 'three', supported: true }
];

test('failover selects the next compatible server in subscription order', () => {
  const next = findNextServer(servers, 'one', new Set(['one']), (server) => server.supported);
  assert.equal(next.id, 'three');
});

test('failover stops after every compatible alternative has failed', () => {
  const next = findNextServer(servers, 'one', new Set(['one', 'three']), (server) => server.supported);
  assert.equal(next, undefined);
});

test('failover starts from the first server when the current id is stale', () => {
  const next = findNextServer(servers, 'missing', new Set(), (server) => server.supported);
  assert.equal(next.id, 'one');
});
