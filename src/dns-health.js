const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');

// This loopback listener uses the running core's configured proxy DNS resolver.
function checkDns(port, timeoutMs = 3000, signal) {
  if (signal?.aborted) return Promise.resolve({ status: 'cancelled', kind: 'dns' });
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const id = randomBytes(2);
    const query = Buffer.concat([id, Buffer.from('01000001000000000000', 'hex'),
      Buffer.from([10]), Buffer.from('cloudflare'), Buffer.from([3]), Buffer.from('com'),
      Buffer.from('0000010001', 'hex')]);
    let settled = false;
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket.close();
      resolve({ status, kind: 'dns' });
    };
    const cancel = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    socket.on('error', () => finish('error'));
    socket.on('message', (message, peer) => {
      if (peer.address !== '127.0.0.1' || peer.port !== port || message.length < 12
        || !message.subarray(0, 2).equals(id) || !(message[2] & 0x80)) return;
      finish((message[3] & 15) === 0 && !(message[2] & 2) && message.readUInt16BE(6) > 0 ? 'ok' : 'error');
    });
    socket.send(query, port, '127.0.0.1');
  });
}

module.exports = { checkDns };
