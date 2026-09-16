function choice(value, values, label) {
  if (!values.includes(value)) throw new Error(`Некорректная настройка: ${label}.`);
  return value;
}
const normalizeKillSwitch = value => choice(value, ['off', 'session', 'always'], 'Kill switch');
const normalizeIpv6 = value => choice(value, ['block', 'tunnel'], 'IPv6');
const normalizeDnsPolicy = value => choice(value, ['routing', 'vpn'], 'DNS');
module.exports = { normalizeKillSwitch, normalizeIpv6, normalizeDnsPolicy };
