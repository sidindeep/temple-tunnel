const test=require('node:test');
const assert=require('node:assert/strict');
const dgram=require('node:dgram');
const {checkDns}=require('../src/dns-health');

async function resolver(t, reply) {
  const socket=dgram.createSocket('udp4');
  await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));
  t.after(()=>socket.close());
  socket.on('message',(query,peer)=>{
    const response=reply(Buffer.from(query));
    if(response)socket.send(response,peer.port,peer.address);
  });
  return socket.address().port;
}
test('DNS health requires a successful answer from the running resolver',async t=>{
  const port=await resolver(t,q=>{q[2]=0x81;q[3]=0x80;q.writeUInt16BE(1,6);return q;});
  assert.equal((await checkDns(port)).status,'ok');
});
test('DNS health rejects SERVFAIL and empty answers',async t=>{
  for(const rcode of [0,2]){
    const port=await resolver(t,q=>{q[2]=0x81;q[3]=0x80|rcode;return q;});
    assert.equal((await checkDns(port)).status,'error');
  }
});
test('DNS health ignores mismatched responses and times out',async t=>{
  const port=await resolver(t,q=>{q[0]^=255;q[2]=0x81;q.writeUInt16BE(1,6);return q;});
  assert.equal((await checkDns(port,50)).status,'timeout');
});
test('DNS health cancels pending requests',async t=>{
  const port=await resolver(t,()=>null);
  const controller=new AbortController();
  const pending=checkDns(port,3000,controller.signal);
  controller.abort();
  assert.equal((await pending).status,'cancelled');
  assert.equal((await checkDns(port,3000,controller.signal)).status,'cancelled');
});
