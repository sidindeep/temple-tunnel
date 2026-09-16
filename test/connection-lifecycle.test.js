const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

async function harness({ strategy = 'auto', probeDelay = 5, verifyError, switchError, switchDelay = 0, allOffline = false, xhttp = false, reserveDelay = 0, hysteria = false, realityXray = false } = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'temple-lifecycle-'));
  const sourcePath = path.join(__dirname, '../src/main.js');
  const realRequire = createRequire(sourcePath);
  const seen = { notices: [], probes: [], switches: [], tunStarts: 0, tunNames:[], saves: 0, verified: 0, online: true, reserveChecks:0 };
  const handlers = {};
  const profiles = ['a','b','c'].map(id=>({id,name:id,host:'192.0.2.1',port:443,transport:'tcp',security:'none',uuid:'test'}));
  if(xhttp)for(const profile of profiles)profile.transport='xhttp';
  if(realityXray)for(const profile of profiles)profile.security='reality';
  if(hysteria)for(const profile of profiles)Object.assign(profile,{protocol:'hysteria2',transport:'hysteria2',password:'test',security:'tls',serverName:'example.com'});
  const context = vm.createContext({
    require(name) {
      if(name==='./connection-notices')return {createConnectionNotices:()=>realRequire(name).createConnectionNotices((title,body)=>seen.notices.push({title,body}))};
      if(name==='electron')return {net:{isOnline:()=>seen.online},app:{disableHardwareAcceleration(){},requestSingleInstanceLock:()=>true,on(){},whenReady:()=>({then(){}})},ipcMain:{handle:(name,handler)=>{handlers[name]=handler;}}};
      if(name==='./tunnel-pool')return {...realRequire(name),selectOutbound:async(_pool,id,signal)=>{
        seen.switches.push(id);if(switchDelay)await delay(switchDelay,undefined,{signal});if(switchError)throw switchError;
      }};
      if(name==='./latency')return {...realRequire(name),checkTunnelReadiness:async()=>({status:seen.healthStatus || 'ok'}),checkTunnelConnectivity:async(_port,_timeout,_probe,signal)=>{
        seen.reserveChecks++;if(reserveDelay)await delay(reserveDelay,undefined,{signal});return {status:'ok',ms:20,kind:'tunnel'};
      }};
      if(name==='node:fs')return {...fs,existsSync:()=>true};
      if(name==='node:child_process')return {execFile:realRequire(name).execFile,spawn(_exe,args) {
        seen.tunStarts++;
        const config=JSON.parse(fs.readFileSync(args.includes('-c') ? args[args.indexOf('-c')+1] : args.at(-1)));
        const tun=config.inbounds?.find(i=>i.type==='tun');if(tun)seen.tunNames.push(tun.interface_name);
        const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();
        child.kill=()=>{queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);});return true;};
        child.stdin=new PassThrough();child.stdin.on('finish',()=>child.kill());
        return child;
      }};
      if(name==='./server-probe')return {resolveServer:async server=>server,probeServer:async(server,_exe,_xray,{signal})=>{
        seen.probes.push(server.id);
        try { await delay(probeDelay,undefined,{signal}); }
        catch { return {status:'cancelled'}; }
        if(allOffline)return {status:'timeout',reason:'network',ms:null};
        if(server.id==='a')return {status:'auth-error',reason:'auth',ms:null};
        return {status:'ok',ms:5,kind:'tunnel',resolvedServer:realityXray?{...server,connectionEngine:'xray'}:server};
      }};
      return realRequire(name);
    },
    setTimeout,clearTimeout,setInterval,clearInterval,AbortController,console,process,Buffer,
    __dirname:path.dirname(sourcePath),directory,profiles,strategy,seen,verifyError
  });
  vm.runInContext(fs.readFileSync(sourcePath,'utf8')+`
    runtimeDir = () => directory;
    rulesPath = () => ({});
    servers = () => profiles;
    subscriptions = () => [{id:'sub',servers:profiles}];
    storeSubscriptions = () => {};
    saveState = async () => { seen.saves++; };
    log = () => {}; pushState = () => {};
    validateCoreConfig = async () => {};
    let nextPort = 12345; allocateLoopbackPort = async () => nextPort++;
    waitForLocalPort = async () => {};
    waitForVerifiedTunnel = async () => {seen.verified++; if(verifyError)throw verifyError;return {status:'ok',ms:5,kind:'tunnel'};};
    state.mode='full';state.selectedServerId='a';state.activeSubscriptionId='sub';state.connectionStrategy=strategy;
    globalThis.start = startTunnel;globalThis.stop = stopTunnel;
    globalThis.snapshot = () => ({status:state.status,selected:state.selectedServerId,error:state.error,
      recovery:automaticRecoveryActive,history:selectionHistory(),running:Boolean(coreProcess)});
  `,context);
  const source=fs.readFileSync(sourcePath,'utf8');
  vm.runInContext(source.slice(source.indexOf("  ipcMain.handle('settings:update'"), source.indexOf("  ipcMain.handle('tunnel:toggle'")),context);
  return {context,seen,handlers,async dispose(){await context.stop({immediate:true});await fsp.rm(directory,{recursive:true,force:true});}};
}

function fakeGuard(h, mode = 'session') {
  vm.runInContext(`state.killSwitch='${mode}';seen.guardEvents=[];seen.guardActive=false;
    networkGuard={get active(){return seen.guardActive;},async apply(_state,_cores,tun){
      seen.guardEvents.push(tun || '-');if(seen.guardFailure)throw new Error('Firewall unavailable');seen.guardActive=true;
    },async clear(){seen.guardEvents.push('clear');seen.guardActive=false;}};`,h.context);
}
test('kill switch arms before core startup and survives a core failure',async()=>{
  const h=await harness();fakeGuard(h);
  try{
    await h.context.start();assert.equal(h.seen.guardActive,true);assert.equal(h.seen.guardEvents[0],'-');
    assert.ok(h.seen.guardEvents.some(value=>value.startsWith('temple-tun-')));
    vm.runInContext("coreProcess.exitCode=1;coreProcess.emit('exit',1)",h.context);
    assert.equal(h.seen.guardActive,true);
    await vm.runInContext('manualDisconnect()',h.context);assert.equal(h.seen.guardActive,false);
  }finally{await h.dispose();}
});
test('permanent kill switch remains armed after manual disconnect',async()=>{
  const h=await harness();fakeGuard(h,'always');
  try{await h.context.start();await vm.runInContext('manualDisconnect()',h.context);assert.equal(h.seen.guardActive,true);assert.equal(h.seen.guardEvents.at(-1),'-');}
  finally{await h.dispose();}
});
test('firewall failure prevents starting an unprotected VPN',async()=>{
  const h=await harness();fakeGuard(h);h.seen.guardFailure=true;
  try{await assert.rejects(h.context.start(),/Firewall/);assert.equal(h.seen.tunStarts,0);assert.equal(h.context.snapshot().status,'error');}
  finally{await h.dispose();}
});

test('a verified TCP fallback starts Xray alongside the working TUN',async()=>{
 const h=await harness({realityXray:true});
 try{await h.context.start();assert.equal(h.context.snapshot().status,'connected');assert.equal(h.seen.tunStarts,2);assert.equal(vm.runInContext('activePool.bridgeIds.has(state.selectedServerId)',h.context),true);
 assert.equal(vm.runInContext('[...activePool.members.keys()].every(id=>activePool.bridgeIds.has(id))',h.context),true);}
 finally{await h.dispose();}
});

test('Hysteria authenticates only in the main core and does not warm reserve sessions',async()=>{
 const h=await harness({hysteria:true});
 try{
  await h.context.start();
  assert.equal(h.context.snapshot().status,'connected');
  assert.deepEqual(h.seen.probes,[]);
  assert.equal(h.seen.tunStarts,1);assert.equal(h.seen.verified,1);
  assert.equal(vm.runInContext('activePool.probePorts.size',h.context),0);
  assert.equal(h.context.snapshot().history.lastSuccessfulId,'a');
 }finally{await h.dispose();}
});

test('manual server outage preserves the TUN and recovers on the same server',async()=>{
 const h=await harness({hysteria:true,strategy:'manual'});
 try{
  vm.runInContext("state.mode='bypass';state.bypassApplications=[{processName:'Tanki.exe'}]",h.context);
  await h.context.start();
  vm.runInContext("globalThis.originalCore=coreProcess;scheduleFailover('server offline')",h.context);
  assert.equal(h.context.snapshot().status,'reconnecting');
  assert.equal(h.context.snapshot().running,true);
  assert.equal(h.seen.notices.length,1);
  assert.equal(h.seen.notices[0].title,'Соединение VPN потеряно');
  assert.match(h.seen.notices[0].body,/этого сервера/);
  h.seen.healthStatus='timeout';
  await vm.runInContext('checkActiveTunnelHealth()',h.context);
  assert.equal(h.context.snapshot().status,'reconnecting');
  assert.equal(h.seen.notices.length,1);
  assert.equal(vm.runInContext('coreProcess===originalCore',h.context),true);
  h.seen.healthStatus='ok';
  await vm.runInContext('checkActiveTunnelHealth()',h.context);
  assert.equal(h.context.snapshot().status,'connected');
  assert.equal(h.context.snapshot().selected,'a');
  assert.equal(h.seen.tunStarts,1);
  assert.deepEqual(h.seen.switches,[]);
  assert.equal(vm.runInContext('state.warning',h.context),'');
  assert.equal(h.seen.notices.length,2);
  assert.equal(h.seen.notices[1].title,'VPN восстановлен');
 }finally{await h.dispose();}
});

test('stopping a retained tunnel cancels recovery and subsequent health checks',async()=>{
 const h=await harness({hysteria:true,strategy:'manual'});
 try{
  await h.context.start();
  vm.runInContext("scheduleFailover('server offline')",h.context);
  await h.context.stop({immediate:true});
  await vm.runInContext('checkActiveTunnelHealth()',h.context);
  assert.equal(h.context.snapshot().status,'disconnected');
  assert.equal(h.context.snapshot().running,false);
  assert.equal(vm.runInContext('awaitingServerRecovery',h.context),false);
  assert.equal(h.seen.notices.length,1);
 }finally{await h.dispose();}
});

test('manual core exit reports VPN stopped before cleanup clears notices',async()=>{
 const h=await harness({hysteria:true,strategy:'manual'});
 try{
  await h.context.start();
  vm.runInContext("coreProcess.exitCode=1;coreProcess.emit('exit',1)",h.context);
  await delay(30);
  assert.equal(h.context.snapshot().status,'error');
  assert.equal(h.seen.notices.length,1);
  assert.equal(h.seen.notices[0].title,'VPN отключён');
 }finally{await h.dispose();}
});

test('mixed subscriptions can fall back to Hysteria without a disposable session',async()=>{
 const h=await harness({allOffline:true});
 try{
  vm.runInContext("Object.assign(profiles[1],{protocol:'hysteria2',transport:'hysteria2',password:'test',security:'tls',serverName:'example.com'})",h.context);
  await h.context.start();
  assert.equal(h.context.snapshot().status,'connected');
  assert.equal(h.context.snapshot().selected,'b');
  assert.ok(!h.seen.probes.includes('b'));
 }finally{await h.dispose();}
});

test('stopping during Hysteria main verification cannot publish a late success',async()=>{
 const h=await harness({hysteria:true});
 try{
  vm.runInContext('waitForVerifiedTunnel=async()=>{seen.verified++;await new Promise(resolve=>setTimeout(resolve,100));return {status:"ok",ms:5}}',h.context);
  const pending=h.context.start();
  while(!h.seen.verified)await delay(1);
  assert.equal(h.context.snapshot().status,'connecting');
  await h.context.stop({immediate:true});await pending;
  assert.equal(h.context.snapshot().status,'disconnected');
  assert.equal(h.context.snapshot().running,false);
 }finally{await h.dispose();}
});

test('failed Hysteria main verification never reports a successful manual connection',async()=>{
 const h=await harness({hysteria:true,strategy:'manual',verifyError:Object.assign(Error('auth'),{code:'AUTH_FAILED'})});
 try{
  await h.context.start();
  assert.deepEqual(h.seen.probes,[]);
  assert.equal(h.context.snapshot().status,'error');
  assert.equal(h.context.snapshot().running,false);
  assert.notEqual(h.context.snapshot().history.lastSuccessfulId,'a');
 }finally{await h.dispose();}
});

test('failed Hysteria verification schedules automatic recovery and stop cancels it',async()=>{
 const h=await harness({hysteria:true,verifyError:Object.assign(Error('auth'),{code:'AUTH_FAILED'})});
 try{
  await h.context.start();
  assert.equal(h.context.snapshot().recovery,true);
  await h.context.stop({immediate:true});
  assert.equal(h.context.snapshot().status,'disconnected');
  assert.equal(h.context.snapshot().recovery,false);
 }finally{await h.dispose();}
});

test('outage schedules a quick retry and stop cancels the pending retry',async()=>{
  const h=await harness({allOffline:true});
  try {
    await h.context.start();
    assert.equal(h.context.snapshot().status,'reconnecting');
    const remaining=vm.runInContext('networkRetryAt-Date.now()',h.context);
    assert.ok(remaining>1500 && remaining<=2000);
    assert.equal(vm.runInContext('networkRetryAttempt',h.context),1);
    await h.context.stop({immediate:true});
    assert.equal(vm.runInContext('networkRetryAt',h.context),0);
    assert.equal(vm.runInContext('networkRetryAttempt',h.context),0);
    assert.equal(vm.runInContext('networkReconnect',h.context),false);
    assert.equal(h.context.snapshot().status,'disconnected');
  } finally {await h.dispose();}
});

test('successful connection resets accumulated retry delay',async()=>{
  const h=await harness();
  try {
    vm.runInContext('networkRetryAttempt=3;networkRetryAt=Date.now()+15000',h.context);
    await h.context.start({retry:true});
    assert.equal(h.context.snapshot().status,'connected');
    assert.equal(vm.runInContext('networkRetryAttempt',h.context),0);
    assert.equal(vm.runInContext('networkRetryAt',h.context),0);
  } finally {await h.dispose();}
});

test('auto selection starts TUN only for a verified winner and remembers it',async()=>{
  const h=await harness();
  try {
    await h.context.start();
    const state=h.context.snapshot();
    assert.equal(state.status,'connected');assert.equal(state.selected,'b');
    assert.equal(h.seen.tunStarts,1);assert.equal(h.seen.verified,1);
    assert.equal(state.history.lastSuccessfulId,'b');
    assert.equal(state.history.history.a.failures,1);
  } finally {await h.dispose();}
});

test('manual selection never tries a different server or starts TUN on a bad key',async()=>{
  const h=await harness({strategy:'manual'});
  try {
    await h.context.start();
    assert.deepEqual(h.seen.probes,['a']);assert.equal(h.seen.tunStarts,0);
    const state=h.context.snapshot();assert.equal(state.status,'error');assert.equal(state.selected,'a');
    assert.equal(state.recovery,false);assert.match(state.error,/авторизацию/);
  } finally {await h.dispose();}
});

test('stop during selection cancels the operation without late TUN or error state',async()=>{
  const h=await harness({probeDelay:1000});
  try {
    const pending=h.context.start();
    while(!h.seen.probes.length)await delay(1);
    await h.context.stop({immediate:true});await pending;
    assert.equal(h.seen.tunStarts,0);assert.equal(h.context.snapshot().status,'disconnected');
    assert.equal(h.context.snapshot().error,'');assert.equal(h.context.snapshot().recovery,false);
  } finally {await h.dispose();}
});

test('local TUN error stops without cycling through more VPN servers',async()=>{
  const h=await harness({verifyError:Object.assign(Error('TUN permissions'),{code:'TUN_FAILED'})});
  try {
    await h.context.start();
    const state=h.context.snapshot();
    assert.equal(state.status,'error');assert.equal(state.recovery,false);assert.equal(state.running,false);
    assert.equal(h.seen.tunStarts,1);assert.equal(state.history.lastSuccessfulId,'');
  } finally {await h.dispose();}
});

test('stale cleanup without a config cannot delete a newer runtime config',async()=>{
  const h=await harness();
  try {
    await vm.runInContext(`(async()=>{
      coreConfigPath=path.join(directory,'new.json');await fsp.writeFile(coreConfigPath,'{}');
      await removeRuntimeConfig(undefined);
      globalThis.configSurvived=await fsp.readFile(coreConfigPath,'utf8');
    })()`,h.context);
    assert.equal(h.context.configSurvived,'{}');
  } finally {await h.dispose();}
});

test('changing selection policy keeps an established healthy tunnel',async()=>{
  const h=await harness();
  try {
    await h.context.start();
    for(const connectionStrategy of ['manual','auto']) {
      const state=await h.handlers['settings:update'](null,{connectionStrategy});
      assert.equal(state.connectionStrategy,connectionStrategy);assert.equal(state.status,'connected');
    }
    assert.equal(h.seen.tunStarts,1);
  } finally {await h.dispose();}
});

test('clicking a server explicitly selects manual mode and switches to that server',async()=>{
  const h=await harness();
  try {
    await h.context.start();
    const state=await h.handlers['settings:update'](null,{selectedServerId:'c'});
    assert.equal(state.connectionStrategy,'manual');assert.equal(state.selectedServerId,'c');
    assert.equal(state.status,'connected');assert.deepEqual(h.seen.switches,['c']);
    assert.equal(h.seen.tunStarts,1);assert.equal(h.seen.verified,2);
  } finally {await h.dispose();}
});

test('failed control API falls back to verified cold connection',async()=>{
  const h=await harness({switchError:Error('API unavailable')});
  try {
    await h.context.start();
    await h.handlers['settings:update'](null,{selectedServerId:'c'});
    assert.equal(h.context.snapshot().status,'connected');
    assert.equal(h.seen.tunStarts,2);assert.deepEqual(h.seen.switches,['c']);
  }finally{await h.dispose();}
});

test('XHTTP group switches verified servers while keeping both Xray and TUN processes',async()=>{
  const h=await harness({xhttp:true});
  try {
    await h.context.start();
    assert.equal(h.context.snapshot().status,'connected');assert.equal(h.seen.tunStarts,2);
    await h.handlers['settings:update'](null,{selectedServerId:'c'});
    assert.equal(h.context.snapshot().status,'connected');assert.deepEqual(h.seen.switches,['c']);
    assert.equal(h.seen.tunStarts,2);
  }finally{await h.dispose();}
});

test('reserve check uses existing core, preserves active server and does not write preferences',async()=>{
  const h=await harness();
  try {
    await h.context.start();const saves=h.seen.saves;
    await vm.runInContext('checkPreparedReserve()',h.context);
    assert.equal(h.seen.reserveChecks,1);assert.equal(h.seen.tunStarts,1);assert.equal(h.seen.saves,saves);
    assert.equal(h.context.snapshot().selected,'b');assert.equal(h.seen.switches.length,0);
    assert.equal(vm.runInContext("activePool.checks.get('c').status",h.context),'ok');
  }finally{await h.dispose();}
});

test('a stopped standby Xray does not tear down a healthy native connection',async()=>{
  const h=await harness({xhttp:true});
  try {
    vm.runInContext("profiles.find(p=>p.id==='c').transport='tcp'",h.context);
    await h.context.start();
    await h.handlers['settings:update'](null,{selectedServerId:'c'});
    vm.runInContext("xrayProcess.exitCode=0;xrayProcess.emit('exit',0)",h.context);
    assert.equal(h.context.snapshot().status,'connected');assert.equal(h.context.snapshot().running,true);
    assert.equal(h.seen.tunStarts,2);
    assert.equal(vm.runInContext("activePool.members.has('b')",h.context),false);
  }finally{await h.dispose();}
});

test('manual stop cancels a pending reserve check without late state updates',async()=>{
  const h=await harness({reserveDelay:1000});
  try {
    await h.context.start();const pending=vm.runInContext('checkPreparedReserve()',h.context);
    while(!h.seen.reserveChecks)await delay(1);
    await h.context.stop();await pending;
    assert.equal(h.context.snapshot().status,'disconnected');assert.equal(h.seen.tunStarts,1);
  }finally{await h.dispose();}
});

test('routing changes rebuild TUN instead of reusing a stale group',async()=>{
  const h=await harness();
  try {
    await h.context.start();
    await h.handlers['settings:update'](null,{russianSitesViaVpn:false});
    assert.equal(h.seen.tunStarts,2);assert.deepEqual(h.seen.switches,[]);
    assert.equal(h.seen.tunNames.length,2);assert.notEqual(h.seen.tunNames[0],h.seen.tunNames[1]);
    assert.ok(h.seen.tunNames.every(name=>/^temple-tun-[0-9a-f]{12}$/.test(name)));
  }finally{await h.dispose();}
});

test('DNS and domain settings rebuild the running tunnel and reject invalid edits before saving',async()=>{
  const h=await harness();
  try {
    await h.context.start();
    await h.handlers['settings:update'](null,{dnsPreset:'cloudflare',customRouting:{proxy:'example.com'}});
    assert.equal(h.seen.tunStarts,2);assert.equal(h.seen.switches.length,0);
    const saves=h.seen.saves;
    await assert.rejects(h.handlers['settings:update'](null,{dnsPreset:'google',customRouting:{proxy:'https://invalid.example'}}));
    assert.equal(h.seen.saves,saves);assert.equal(h.seen.tunStarts,2);
    assert.equal(vm.runInContext('state.dnsPreset',h.context),'cloudflare');
  }finally{await h.dispose();}
});

test('offline connection waits without probing or penalizing servers; manual stop cancels it',async()=>{
  const h=await harness();
  try {
    h.seen.online=false;
    await h.context.start();
    assert.equal(h.context.snapshot().status,'reconnecting');
    assert.equal(h.seen.probes.length,0);
    await h.context.stop();h.seen.online=true;
    await vm.runInContext('pollNetwork()',h.context);
    assert.equal(h.context.snapshot().status,'disconnected');
    assert.equal(h.seen.tunStarts,0);
  }finally{await h.dispose();}
});

test('sleep cancels active TUN and wake restores a verified connection',async()=>{
  const h=await harness();
  try {
    await h.context.start();
    await vm.runInContext('networkSuspended=true; pauseForNetwork()',h.context);
    assert.equal(h.context.snapshot().status,'reconnecting');
    assert.equal(h.context.snapshot().history.history.b.failures,0);
    await vm.runInContext('networkSuspended=false; pollNetwork()',h.context);
    await vm.runInContext('networkStableAt=0; pollNetwork()',h.context);
    assert.equal(h.context.snapshot().status,'connected');
    assert.equal(h.context.snapshot().selected,'b');
  }finally{await h.dispose();}
});

test('an entire unreachable batch does not quarantine every server',async()=>{
  const h=await harness({allOffline:true});
  try {
    await h.context.start();
    assert.equal(Object.keys(h.context.snapshot().history.history).length,0);
    assert.equal(h.seen.tunStarts,0);
  }finally{await h.dispose();}
});

test('immediate stop after start cannot be overtaken by asynchronous preflight',async()=>{
  const h=await harness();
  try {
    const pending=h.context.start();await h.context.stop();await pending;
    assert.equal(h.seen.tunStarts,0);assert.equal(h.context.snapshot().status,'disconnected');
  }finally{await h.dispose();}
});

test('stop during an outstanding hot switch cancels it without restarting TUN',async()=>{
  const h=await harness({switchDelay:1000});
  try {
    await h.context.start();
    vm.runInContext("state.selectedServerId='c'",h.context);
    const pending=h.context.start();
    while(!h.seen.switches.length)await delay(1);
    await h.context.stop();await pending;
    assert.equal(h.seen.tunStarts,1);assert.equal(h.context.snapshot().status,'disconnected');
    assert.equal(h.context.snapshot().running,false);
  }finally{await h.dispose();}
});
