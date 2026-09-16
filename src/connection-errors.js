function connectionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function classifyConnectionError(error) {
  const code = error?.code;
  const message = String(error?.message || error || '');
  if (['ABORT_ERR', 'TUNNEL_SUPERSEDED', 'RECOVERY_CANCELLED'].includes(code)) return 'cancelled';
  if (['NO_WORKING_SERVER','NO_CANDIDATES'].includes(code)) return 'network';
  if (code === 'AUTH_FAILED' || /authentication failed|invalid user|invalid password/i.test(message)) return 'auth';
  if (['DNS_FAILED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (['ENOENT', 'EACCES', 'EPERM', 'ENGINE_FAILED', 'CORE_READY_TIMEOUT', 'LOCAL_CONFIG', 'TUN_FAILED'].includes(code)
    || /access is denied|operation not permitted|wintun|create tun|права администратора|не найден|Переустановите приложение|свободный адрес|хотя бы одно приложение/i.test(message)) return 'local';
  if (code === 'PROFILE_INVALID') return 'profile';
  return 'network';
}

const messages = {
  cancelled: 'Подключение отменено.',
  auth: 'Сервер отклонил авторизацию. Обновите подписку или выберите другой сервер.',
  dns: 'Не удалось определить адрес VPN-сервера. Проверьте доступ к интернету и DNS.',
  local: 'Не удалось запустить VPN на компьютере. Проверьте права администратора и установку приложения.',
  profile: 'Конфигурация сервера несовместима с VPN-движком. Обновите подписку или выберите другой сервер.',
  network: 'Сервер не подтвердил защищённое соединение. Попробуйте другой сервер или повторите позже.'
};

module.exports = { connectionError, classifyConnectionError, connectionErrorMessages: messages };
