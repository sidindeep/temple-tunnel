const test = require('node:test');
const assert = require('node:assert/strict');
const { retryDelay } = require('../src/retry-policy');

test('outage retries start quickly and cap at fifteen seconds', () => {
  assert.deepEqual([0,1,2,3,4,20].map(retryDelay), [2000,5000,10000,15000,15000,15000]);
});
