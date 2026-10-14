const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { reserveLoopbackPort } = require('../src/loopback-port');

test('health port is available for both native TCP and UDP listeners and reservations close', async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await reserveLoopbackPort({ udp: true });
    assert.ok(port > 0 && port <= 65535);
    const tcp = net.createServer();
    const udp = dgram.createSocket('udp4');
    try {
      tcp.listen(port, '127.0.0.1'); await once(tcp, 'listening');
      udp.bind(port, '127.0.0.1'); await once(udp, 'listening');
      assert.equal(tcp.address().port, udp.address().port);
    } finally {
      if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
      await new Promise(resolve => udp.close(resolve));
    }
  }
});

test('port search has a bounded failure instead of returning an unchecked port', async () => {
  await assert.rejects(reserveLoopbackPort({ udp: true, attempts: 0 }), /свободный локальный порт/);
});
