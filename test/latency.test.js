const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { measureTcpLatency, measureEndpointLatency } = require('../src/latency');

function trackConnections(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

test('TCP latency probe reports a reachable local server', async () => {
  const server = net.createServer();
  const sockets = trackConnections(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const result = await measureTcpLatency({ host: '127.0.0.1', port: address.port }, 1000);
  assert.equal(result.status, 'ok');
  assert.equal(Number.isInteger(result.ms), true);
  assert.equal(result.ms >= 1, true);
  await closeServer(server, sockets);
});

test('TLS endpoint probe does not accept a local TCP handshake as real latency', async () => {
  const server = net.createServer(() => {});
  const sockets = trackConnections(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const result = await measureEndpointLatency({
    host: '127.0.0.1',
    port: address.port,
    serverName: 'example.test',
    security: 'tls'
  }, 80);
  assert.notEqual(result.status, 'ok');
  assert.equal(result.ms, null);
  await closeServer(server, sockets);
});
