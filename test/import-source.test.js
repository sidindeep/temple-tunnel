const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {validateSource,readImport}=require('../src/import-source');
const {downloadSubscription}=require('../src/subscription');
const key='vless://11111111-1111-4111-8111-111111111111@example.com:443?security=tls&type=tcp#Test';
test('multiline imports deduplicate profiles and report unsupported entries',async()=>{
  const source=`${key}\n${key}\nvmess://unsupported`;
  assert.match(validateSource(source).report,/Распознано: 1.*Пропущено: 1.*Повторов: 1/);
  assert.equal((await downloadSubscription(source)).length,1);
  assert.throws(()=>validateSource('javascript:alert(1)'));
  assert.throws(()=>validateSource('https://user:pass@example.com'),/пароль/);
});
test('subscription size limit interrupts a chunked response before full allocation',async()=>{
  let reads=0;
  await assert.rejects(downloadSubscription('https://example.com/sub',async()=>({ok:true,headers:new Headers(),body:(async function*(){for(let i=0;i<20;i++){reads++;yield Buffer.alloc(1024*1024);}})()})),/слишком большой/);
  assert.equal(reads,6);
});
test('QR image decoding converts BGRA, accepts only supported payloads and reports missing QR',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'temple-qr-test-'));
  try {
    const file=path.join(root,'image.png');
    const header=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(header);header.write('IHDR',12);header.writeUInt32BE(1,16);header.writeUInt32BE(1,20);await fs.writeFile(file,header);
    const nativeImage={createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:1,height:1}),toBitmap:()=>Buffer.from([10,20,30,255])})};
    const decoded=await readImport(file,true,nativeImage,(rgba,w,h)=>{assert.deepEqual([...rgba],[30,20,10,255]);assert.equal(w*h,1);return{data:key};});
    assert.equal(decoded.source,key);
    await assert.rejects(readImport(file,true,nativeImage,()=>null),/QR-код не найден/);
    await assert.rejects(readImport(file,true,nativeImage,()=>({data:'https://user:pass@example.com'})),/пароль/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
