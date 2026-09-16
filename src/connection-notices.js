function createConnectionNotices(send) {
  let connected = false;
  let incident = false;
  return {
    connected(serverName) {
      if (incident) send('VPN восстановлен', `Подключено к серверу «${String(serverName).slice(0, 100)}».`);
      incident = false;
      connected = true;
    },
    lost(body = 'Пытаемся восстановить подключение…') {
      if (!connected || incident) return;
      incident = true;
      send('Соединение VPN потеряно', body);
    },
    stopped() {
      if (connected) send('VPN отключён', 'VPN-туннель остановился. Подключитесь заново в приложении. Трафик больше не защищён VPN.');
      incident = false;
      connected = false;
    },
    failed() {
      if (incident) send('Не удалось восстановить VPN', 'Доступные варианты закончились. Откройте приложение и выберите другой сервер или подписку.');
      incident = false;
      connected = false;
    },
    cancel() { connected = false; incident = false; }
  };
}
module.exports = { createConnectionNotices };
