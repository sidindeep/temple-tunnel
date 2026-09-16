const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');
const DNS_PRESETS = {
  legacy: { type: 'udp', server: '1.1.1.1', server_port: 53 },
  cloudflare: { type: 'https', server: '1.1.1.1', server_port: 443, path: '/dns-query', tls: { enabled: true, server_name: 'cloudflare-dns.com' } },
  google: { type: 'https', server: '8.8.8.8', server_port: 443, path: '/dns-query', tls: { enabled: true, server_name: 'dns.google' } },
  quad9: { type: 'https', server: '9.9.9.9', server_port: 443, path: '/dns-query', tls: { enabled: true, server_name: 'dns.quad9.net' } }
};
function normalizeRouting(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные настройки маршрутов.');
  const result = { proxy: [], direct: [], block: [] };
  const seen = new Map();
  for (const action of Object.keys(result)) {
    const input = value[action] ?? [];
    if ((!Array.isArray(input) && typeof input !== 'string') || input.length > 65536) throw new Error('Слишком большой список маршрутов.');
    const lines = Array.isArray(input) ? input : input.split(/\r?\n/);
    if (lines.length > 500) throw new Error('Допускается не более 500 адресов в каждом списке.');
    for (const raw of lines) {
      if (typeof raw !== 'string' || raw.length > 253) throw new Error('Некорректный адрес в списке маршрутов.');
      let entry = raw.trim().toLowerCase();
      if (!entry) continue;
      if (entry.includes('/')) {
        const [host, prefix, extra] = entry.split('/');
        const family = isIP(host);
        if (!family || extra !== undefined || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128))
          throw new Error('Укажите IP-подсеть в формате 203.0.113.0/24 или домен без https://.');
        entry = `${host}/${Number(prefix)}`;
      } else if (isIP(entry)) entry += isIP(entry) === 4 ? '/32' : '/128';
      else {
        if (/[:@?#\\%\s]/.test(entry) || /^[\d.]+$/.test(entry)) throw new Error('Некорректный домен или IP-адрес.');
        entry = domainToASCII(entry.replace(/^\*\./, '').replace(/\.$/, ''));
        if (!entry || entry.length > 253 || !entry.includes('.') || !entry.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
          throw new Error('Укажите домен без пути и порта, например example.com.');
      }
      if (seen.has(entry) && seen.get(entry) !== action) throw new Error('Один адрес указан в разных списках. Оставьте его в одном списке.');
      if (!seen.has(entry)) result[action].push(entry);
      seen.set(entry, action);
    }
  }
  return result;
}
function normalizeDns(value = 'legacy') {
  if (!Object.hasOwn(DNS_PRESETS, value)) throw new Error('Выберите DNS из списка.');
  return value;
}
function customRules(settings, dns = false) {
  const normalized = normalizeRouting(settings);
  const rules = [];
  for (const action of ['block', 'proxy', 'direct']) {
    const domains = normalized[action].filter(item => !item.includes('/'));
    const cidrs = normalized[action].filter(item => item.includes('/'));
    const destination = action === 'block' ? { action: 'reject' }
      : dns ? { action: 'route', server: `dns-${action}` } : { action: 'route', outbound: action };
    if (domains.length) rules.push({ domain_suffix: domains, ...destination });
    if (!dns && cidrs.length) rules.push({ ip_cidr: cidrs, ...destination });
  }
  return rules;
}
function proxyDns(preset) {
  return { ...DNS_PRESETS[normalizeDns(preset)], tag: 'dns-proxy', detour: 'proxy' };
}
module.exports = { normalizeRouting, normalizeDns, customRules, proxyDns };
