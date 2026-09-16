const https = require('node:https');
const net = require('node:net');
const { Readable } = require('node:stream');
let protectedDns = false;
const setProtectedDns = active => { protectedDns = Boolean(active); };
const lookup = (host, options) => protectedDns ? encryptedLookup(host) : require('node:dns').promises.lookup(host, options);
const fetchWithProtection = (url, options) => protectedDns ? secureFetch(url, options) : fetch(url, options);
function socketLookup(host, options, callback) {
  if (!protectedDns) return require('node:dns').lookup(host, options, callback);
  encryptedLookup(host).then(result => options.all ? callback(null,[result]) : callback(null,result.address,result.family), callback);
}
// Bootstrap DNS runs in the explicitly permitted app process over HTTPS. It
// must not rely on the shared Windows DNS service while the firewall is armed.
async function encryptedLookup(host) {
  if (net.isIP(host)) return { address: host, family: net.isIP(host) };
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: '1.1.1.1', servername: 'cloudflare-dns.com',
      path: `/dns-query?name=${encodeURIComponent(host)}&type=A`, headers: { Accept: 'application/dns-json' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(new Error('DNS response too large')); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const answer = JSON.parse(body).Answer?.find(item => item.type === 1 && net.isIP(item.data) === 4);
          if (response.statusCode !== 200 || !answer) throw new Error('DNS lookup failed');
          resolve({ address: answer.data, family: 4 });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('DNS lookup timeout')), 5000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject);
  });
}
function secureFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return reject(new Error('HTTPS URL required'));
    const request = https.get(parsed, { headers: options.headers, signal: options.signal,
      lookup(host, opts, callback) { encryptedLookup(host).then(result => opts.all
        ? callback(null, [result]) : callback(null, result.address, result.family), callback); }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy(); reject(new Error('Перенаправление HTTPS отклонено.')); return;
      }
      try {
        const headers = new Headers();
        for (const [key,value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key,String(value));
        const empty = [204,205].includes(response.statusCode);
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on('error', reject);
  });
}
module.exports = { encryptedLookup, secureFetch, setProtectedDns, lookup, fetchWithProtection, socketLookup };
