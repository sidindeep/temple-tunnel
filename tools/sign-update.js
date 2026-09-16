// Offline release tool. The private release key is never packaged with the app.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { hash } = require('../src/signed-updates');
async function main() {
  const keyRoot = path.join(process.env.LOCALAPPDATA,'TempleTunnelRelease');
  const keyFile = path.join(keyRoot,'signing.pem');
  const args = process.argv.slice(2);
  if (args[0] === '--init') {
    await fs.mkdir(keyRoot,{recursive:true});
    const pair = crypto.generateKeyPairSync('ed25519');
    await fs.writeFile(keyFile,pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(__dirname,'../src/release-public.pem'),pair.publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});
    console.log('Release public key installed. Private key remains in the local release-key directory.'); return;
  }
  const [directory,kind,version,minApp,maxApp,singVersion,xrayVersion] = args;
  if (!directory || !['app','cores'].includes(kind)) throw new Error('Usage: node tools/sign-update.js DIRECTORY app|cores VERSION MIN_APP [MAX_APP SING_VERSION XRAY_VERSION]');
  const names = kind === 'app' ? ['setup.exe'] : ['sing-box.exe','xray.exe'];
  const files = [];
  for (let i=0;i<names.length;i++) files.push({name:names[i],...await hash(path.join(directory,names[i])),...(kind === 'cores' ? {version:[singVersion,xrayVersion][i]} : {})});
  const manifest = {schema:1,product:'temple-tunnel',kind,version,minApp,...(kind === 'cores' ? {maxApp} : {}),files};
  const payload = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null,payload,await fs.readFile(keyFile)).toString('base64');
  await fs.writeFile(path.join(directory,'update.json'),JSON.stringify({payload:payload.toString('base64'),signature},null,2));
  console.log('Signed update.json created.');
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
