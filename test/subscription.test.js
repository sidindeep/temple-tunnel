const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeSubscriptionBody, downloadSubscription, isSupportedTransport, parseSubscription, parseVlessUri } = require('../src/subscription');

const REALITY_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GRPC_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const REALITY = `vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&type=tcp&sni=example.org&fp=chrome&pbk=${REALITY_KEY}&sid=abcd&flow=xtls-rprx-vision#Reality%20Node`;
const GRPC = `vless://22222222-2222-4222-8222-222222222222@grpc.example.com:8443?security=reality&type=grpc&serviceName=my-service&sni=cdn.example.com&pbk=${GRPC_KEY}&sid=00ff#GRPC`;
const XHTTP = `vless://33333333-3333-4333-8333-333333333333@xhttp.example.com:443?security=reality&type=xhttp&mode=stream-up&path=%2Fsecret&host=cdn.example.com&sni=www.example.com&fp=chrome&pbk=${REALITY_KEY}&sid=1234&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#XHTTP`;

test('decodes a base64 subscription', () => {
  const encoded = Buffer.from(`${REALITY}\n${GRPC}`).toString('base64');
  assert.equal(decodeSubscriptionBody(encoded), `${REALITY}\n${GRPC}`);
});

test('accepts a direct VLESS key without a network request', async () => {
  const servers = await downloadSubscription(REALITY, () => {
    throw new Error('fetch must not be called for a direct key');
  });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].host, 'example.com');
});

test('downloads HTTPS subscriptions without following redirects', async () => {
  let requestOptions;
  const servers = await downloadSubscription('https://provider.example/subscription', async (_url, options) => {
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(Buffer.byteLength(REALITY)) },
      text: async () => REALITY
    };
  });
  assert.equal(requestOptions.redirect, 'error');
  assert.match(requestOptions.headers['User-Agent'], /^TempleTunnel\/\d+\.\d+\.\d+$/);
  assert.equal(servers.length, 1);
});

test('rejects insecure subscription URLs', async () => {
  await assert.rejects(() => downloadSubscription('http://provider.example/subscription'), /только HTTPS/i);
});

test('rejects an oversized declared subscription response', async () => {
  await assert.rejects(() => downloadSubscription('https://provider.example/subscription', async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(6 * 1024 * 1024) },
    text: async () => REALITY
  })), /слишком большой/i);
});

test('rejects an excessively large pasted key', async () => {
  await assert.rejects(() => downloadSubscription(`vless://${'a'.repeat(300 * 1024)}`), /слишком большие/i);
});

test('parses VLESS REALITY fields', () => {
  const server = parseVlessUri(REALITY);
  assert.equal(server.name, 'Reality Node');
  assert.equal(server.security, 'reality');
  assert.equal(server.transport, 'tcp');
  assert.equal(server.flow, 'xtls-rprx-vision');
  assert.equal(server.publicKey, REALITY_KEY);
});

test('rejects a malformed REALITY public key', () => {
  const invalid = REALITY.replace(REALITY_KEY, '12345');
  assert.throws(() => parseVlessUri(invalid), /некорректный публичный ключ/i);
});

test('rejects provider placeholders that point to loopback', () => {
  const placeholder = REALITY.replace('example.com', '127.0.0.1');
  assert.throws(() => parseVlessUri(placeholder), /служебную заглушку/i);
});

test('parses gRPC transport', () => {
  const [first, second] = parseSubscription(`${REALITY}\n${GRPC}`);
  assert.equal(first.host, 'example.com');
  assert.equal(second.transport, 'grpc');
  assert.equal(second.serviceName, 'my-service');
});

test('reports supported and unsupported transports', () => {
  assert.equal(isSupportedTransport('tcp'), true);
  assert.equal(isSupportedTransport('gRPC'), true);
  assert.equal(isSupportedTransport('xhttp'), true);
  assert.equal(isSupportedTransport('quic'), false);
});

test('parses XHTTP transport parameters', () => {
  const server = parseVlessUri(XHTTP);
  assert.equal(server.transport, 'xhttp');
  assert.equal(server.xhttpMode, 'stream-up');
  assert.equal(server.path, '/secret');
  assert.equal(server.hostHeader, 'cdn.example.com');
  assert.deepEqual(server.xhttpExtra, { xPaddingBytes: '100-1000' });
});
