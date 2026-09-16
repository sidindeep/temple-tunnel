const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),dns=require('node:dns').promises;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'temple-auth-inventory-'));
const data=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(data,'Local State'),path.join(scratch,'Local State'));app.setPath('userData',scratch);
app.whenReady().then(async()=>{
 try {
  const settings=JSON.parse(fs.readFileSync(path.join(data,'settings.json')));
  const subs=JSON.parse(safeStorage.decryptString(Buffer.from(settings.subscriptionsEncrypted,'base64')));
  const active=subs.find(s=>s.id===settings.activeSubscriptionId);
  const passwords=[],rows=[];
  for(const s of active.servers){
   if(!passwords.includes(s.password))passwords.push(s.password);
   rows.push({id:s.id,host:s.host,port:s.port,protocol:s.protocol,serverName:s.serverName,
    credentialGroup:passwords.indexOf(s.password)+1,allowInsecure:s.allowInsecure,obfs:s.obfs?.type,
    selected:s.id===settings.selectedServerId,addresses:await dns.lookup(s.host,{all:true}).catch(()=>[])});
  }
  fs.writeFileSync(path.join(__dirname,'../.cache/auth-inventory.json'),JSON.stringify(rows,null,2));
 }finally{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}app.exit();}
});
