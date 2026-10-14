const net = require('node:net');
const dgram = require('node:dgram');
const { once } = require('node:events');

// Availability is a snapshot; the core still owns the eventual listener bind.
// TCP and UDP have independent Windows exclusions and ephemeral allocators.
async function reserveLoopbackPort({ udp = false, attempts = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const tcp = net.createServer();
    const datagram = udp ? dgram.createSocket('udp4') : undefined;
    try {
      let port;
      if (udp && attempt % 2) {
        datagram.bind(0, '127.0.0.1');
        await once(datagram, 'listening');
        port = datagram.address().port;
        tcp.listen(port, '127.0.0.1');
        await once(tcp, 'listening');
      } else {
        tcp.listen(0, '127.0.0.1');
        await once(tcp, 'listening');
        port = tcp.address().port;
        if (datagram) {
          datagram.bind(port, '127.0.0.1');
          await once(datagram, 'listening');
        }
      }
      return port;
    } catch (error) {
      if (!['EACCES', 'EADDRINUSE'].includes(error.code)) throw error;
    } finally {
      if (tcp.listening) await new Promise(resolve => tcp.close(resolve));
      if (datagram) await new Promise((resolve, reject) => {
        try { datagram.close(resolve); }
        catch (error) { error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' ? resolve() : reject(error); }
      });
    }
  }
  throw new Error('Не удалось выбрать свободный локальный порт для VPN-проверки.');
}

module.exports = { reserveLoopbackPort };
