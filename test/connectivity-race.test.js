const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {checkTunnelConnectivity,measureTunnelLatency} = require('../src/latency');
test('first success cancels outstanding probes without waiting',async()=>{
  let cancelled=0;
  const result=await checkTunnelConnectivity(1,3000,async(_port,_timeout,target,signal)=>{
    if(target.host==='www.google.com') return {status:'ok',ms:12};
    return new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled++;resolve({status:'cancelled'});},{once:true}));
  });
  assert.equal(result.status,'ok');assert.equal(cancelled,2);
});
test('early errors do not discard a later success',async()=>{
  const result=await checkTunnelConnectivity(1,3000,async(_port,_timeout,target)=>{
    if(target.host==='1.1.1.1') throw Error('offline');
    if(target.host==='www.google.com') return {status:'error'};
    await new Promise(resolve=>setTimeout(resolve,10));return {status:'ok',ms:10};
  });
  assert.equal(result.status,'ok');
});
test('all failed probes preserve the original fallback result',async()=>{
  const result=await checkTunnelConnectivity(1,3000,async(_port,_timeout,target)=>({status:target.host==='1.1.1.1'?'timeout':'error'}));
  assert.equal(result.status,'timeout');
});
test('abort closes a real pending proxy socket',async()=>{
  const sockets=new Set();
  let accept;
  const accepted=new Promise(resolve=>{accept=resolve;});
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));accept(socket);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const controller=new AbortController();
    const pending=measureTunnelLatency(server.address().port,3000,undefined,controller.signal);
    const socket=await accepted;
    const closed=new Promise(resolve=>socket.once('close',resolve));
    socket.resume();controller.abort();
    assert.equal((await pending).status,'cancelled');await closed;
    assert.equal(sockets.size,0);
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
test('pre-aborted probe does not connect',async()=>{
  const controller=new AbortController();controller.abort();
  assert.equal((await measureTunnelLatency(1,3000,undefined,controller.signal)).status,'cancelled');
});

test('parent cancellation closes all three endpoint checks',async()=>{
  const controller=new AbortController();let closed=0;
  const pending=checkTunnelConnectivity(1,3000,async(_p,_t,_target,signal)=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{closed++;resolve({status:'cancelled'});},{once:true});
  }),controller.signal);
  await Promise.resolve();controller.abort();
  assert.equal((await pending).status,'cancelled');assert.equal(closed,3);
});
