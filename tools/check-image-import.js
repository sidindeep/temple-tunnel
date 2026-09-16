const {app,nativeImage}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const QR=require('qrcode');
const {readImport}=require('../src/import-source');
app.whenReady().then(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-image-check-'));
  try{
    const payload='vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls&type=tcp#ImageTest';
    for(const inverse of [false,true]){
      const png=await QR.toBuffer(payload,{width:600,margin:4,color:inverse?{dark:'#ffffffff',light:'#000000ff'}:undefined});
      for(const format of ['png','jpg']){
        const file=path.join(root,`code.${format}`);
        await fs.writeFile(file,format==='jpg'?nativeImage.createFromBuffer(png).toJPEG(90):png);
        assert.equal((await readImport(file,true,nativeImage)).source,payload);
      }
    }
    console.log('QR PNG/JPEG, normal/inverted: 4 passed. No network or camera used.');
  }finally{await fs.rm(root,{recursive:true,force:true});}
  app.quit();
}).catch(error=>{console.error(error.message);app.exit(1);});
