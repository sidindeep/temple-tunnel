const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { coreDiagnostic, attachCoreLogReader } = require('../src/file-log');

test('common network failures have distinct useful reasons without raw details', () => {
  const cases = [
    ['ERROR outbound: connection reset by peer', /сбросила/],
    ['ERROR dial tcp: network is unreachable', /маршрута/],
    ['ERROR dns: exchange failed: server misbehaving', /DNS/],
    ['ERROR outbound: context canceled', /отменён/],
    ['ERROR connection: upload: EOF', /поток закрыт/],
    ['ERROR outbound/hysteria2: application error 0x100', /QUIC/],
    ['ERROR invalid password', /авторизацию/],
    ['ERROR i/o timeout', /тайм-аут/]
  ];
  for (const [line, reason] of cases) {
    const result = coreDiagnostic(`${line} password=secret private.example 192.0.2.1`);
    assert.match(result, reason);
    assert.doesNotMatch(result, /secret|private\.example|192\.0\.2\.1/);
  }
  assert.match(coreDiagnostic('ERROR outbound: unknown detail token=secret started'), /Неклассифицированная.*исходящее/);
  assert.match(coreDiagnostic('FATAL unknown detail password=secret'), /Критическая/);
});

test('split UTF-8, multiple lines and a final unterminated line are preserved', async () => {
  const stream = new PassThrough(), lines = [];
  attachCoreLogReader(stream, line => lines.push(line));
  const bytes = Buffer.from('INFO ядро started\r\nERROR connection reset by peer\nERROR context canceled');
  const ended = once(stream, 'end');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end();
  await ended;
  assert.deepEqual(lines, ['INFO ядро started', 'ERROR connection reset by peer', 'ERROR context canceled']);
  assert.match(coreDiagnostic(lines[1]), /сбросила/);
});

test('stdout and stderr cannot combine into a false local adapter failure', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough(), lines = [];
  attachCoreLogReader(stdout, line => lines.push(line));
  attachCoreLogReader(stderr, line => lines.push(line));
  const ended = Promise.all([once(stdout, 'end'), once(stderr, 'end')]);
  stdout.write('INFO Wintun');
  stderr.end('ERROR outbound: connection reset by peer\n');
  stdout.end(' started\n');
  await ended;
  assert.deepEqual(lines.sort(), ['ERROR outbound: connection reset by peer', 'INFO Wintun started'].sort());
});

test('oversized lines are bounded and parsing recovers on the next line', async () => {
  const stream = new PassThrough(), lines = [];
  attachCoreLogReader(stream, line => lines.push(line));
  const ended = once(stream, 'end');
  stream.write('x'.repeat(20000));
  stream.end('secret\nERROR connection refused\n');
  await ended;
  assert.deepEqual(lines, ['ERROR diagnostic line exceeded limit', 'ERROR connection refused']);
});
