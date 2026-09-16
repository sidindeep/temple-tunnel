const {app,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createFileLog}=require('../src/file-log');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'temple-journal-read-'));
const source=path.join(app.getPath('appData'),'temple-tunnel');
fs.copyFileSync(path.join(source,'Local State'),path.join(directory,'Local State'));
fs.cpSync(path.join(source,'logs'),path.join(directory,'logs'),{recursive:true});
app.setPath('userData',directory);
app.whenReady().then(async()=>{
 try {
  const journal=await createFileLog(path.join(directory,'logs'),{protect:s=>safeStorage.encryptString(s),unprotect:b=>safeStorage.decryptString(b)});
  const text=await journal.exportText();
  fs.writeFileSync(path.join(__dirname,'../.cache/recent-journal.txt'),text.split('\n').slice(-180).join('\n'));
 }finally{try{fs.rmSync(directory,{recursive:true,force:true});}catch{}app.exit();}
});
