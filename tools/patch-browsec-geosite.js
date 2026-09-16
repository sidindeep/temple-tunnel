const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];

if (!target) {
  throw new Error('Usage: node patch-browsec-geosite.js <dist/main/main.js>');
}

const geoipRuleSet = '{type:"remote",tag:"geoip-ru",format:"binary",url:"https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs",download_detour:tE,update_interval:"1d"}';
const geositeRuleSet = '{type:"remote",tag:"geosite-category-ru",format:"binary",url:"https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs",download_detour:tE,update_interval:"1d"}';
const oldRuleSetBlock = `...a?[${geoipRuleSet}]:[]`;
const newRuleSetBlock = `...a?[${geoipRuleSet},${geositeRuleSet}]:[]`;

const oldDirectRule = '...a?[{rule_set:"geoip-ru",action:"route",outbound:tE}]:[]';
const newDirectRule = '...a?[{rule_set:["geoip-ru","geosite-category-ru"],action:"route",outbound:tE}]:[]';

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first < 0) {
    if (source.includes(after)) {
      return source;
    }
    throw new Error(`${label} was not found; refusing to patch an unknown build`);
  }
  if (first !== last) {
    throw new Error(`${label} occurs more than once; refusing an ambiguous patch`);
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

const original = fs.readFileSync(target, 'utf8');
let patched = replaceExactlyOnce(
  original,
  oldRuleSetBlock,
  newRuleSetBlock,
  'Russian rule-set declaration',
);
patched = replaceExactlyOnce(
  patched,
  oldDirectRule,
  newDirectRule,
  'Russian direct-routing rule',
);

const oldDnsSignature = 'function vE({mode:e,proxyTag:t=eE,dnsDirect:n={source:"remote-fallback"},remoteDnsIp:r="1.1.1.1",refusedSuffixes:o=[]})';
const newDnsSignature = 'function vE({mode:e,proxyTag:t=eE,dnsDirect:n={source:"remote-fallback"},remoteDnsIp:r="1.1.1.1",refusedSuffixes:o=[],directRuleSets:i=[]})';
patched = replaceExactlyOnce(
  patched,
  oldDnsSignature,
  newDnsSignature,
  'DNS builder signature',
);

const oldDnsDirectRules = '...s?[{domain_suffix:[".local",".localhost",".lan"],server:"dns-direct"},{domain:gE(),server:"dns-direct"}]:[{domain_suffix:[".local",".localhost",".lan"],action:"predefined",rcode:"NXDOMAIN"}]';
const newDnsDirectRules = '...s?[{domain_suffix:[".local",".localhost",".lan"],server:"dns-direct"},{domain:gE(),server:"dns-direct"},...i.length>0?[{rule_set:i,server:"dns-direct"}]:[]]:[{domain_suffix:[".local",".localhost",".lan"],action:"predefined",rcode:"NXDOMAIN"}]';
patched = replaceExactlyOnce(
  patched,
  oldDnsDirectRules,
  newDnsDirectRules,
  'Direct DNS rules',
);

const oldDnsCall = 'dns:vE({mode:l,proxyTag:c,dnsDirect:u??void 0,remoteDnsIp:n.dnsRemoteIp,...n.corpVpnCompatEnabled?{refusedSuffixes:n.corpVpnCompatSuffixes}:{}})';
const newDnsCall = 'dns:vE({mode:l,proxyTag:c,dnsDirect:u??void 0,remoteDnsIp:n.dnsRemoteIp,directRuleSets:"proxyExcept"===t.mode&&t.presets.excludeRuGeo?["geosite-category-ru"]:[],...n.corpVpnCompatEnabled?{refusedSuffixes:n.corpVpnCompatSuffixes}:{}})';
patched = replaceExactlyOnce(
  patched,
  oldDnsCall,
  newDnsCall,
  'DNS builder call',
);

const temporary = `${target}.tmp`;
fs.writeFileSync(temporary, patched, 'utf8');
fs.renameSync(temporary, target);

console.log(`Patched ${path.resolve(target)}`);
