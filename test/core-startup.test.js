const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {EventEmitter}=require('node:events');
const {connectionError,classifyConnectionError,connectionErrorMessages}=require('../src/connection-errors');
const {coreDiagnostic,isLocalCoreFailure}=require('../src/file-log');
const source=fs.readFileSync(require.resolve('../src/main'),'utf8');
function verificationFixture(status, freshAuth = false) {
 const child={exitCode:null,authErrorCount:4};
 const context=vm.createContext({Date,setTimeout,connectionError,connectionErrorMessages,
  xrayProcess:null,waitForLocalPort:async()=>{},log:()=>{},
  checkTunnelReadiness:async()=>{if(freshAuth)child.authErrorCount++;return {status,ms:12};}});
 vm.runInContext(source.slice(source.indexOf('async function waitForVerifiedTunnel('),source.indexOf('function waitForProcessExit(')),context);
 return ()=>context.waitForVerifiedTunnel(child,12345);
}
test('historical auth failures cannot reject a verified connection',async()=>{
 assert.equal((await verificationFixture('ok')()).status,'ok');
});
test('successful TLS proof wins over concurrent auth diagnostics',async()=>{
 assert.equal((await verificationFixture('ok',true)()).status,'ok');
});
test('fresh auth refusal during a failed verification retains its classification',async()=>{
 await assert.rejects(verificationFixture('error',true)(),{code:'AUTH_FAILED'});
});
function fixture(readyAt,abortedAt=Infinity){
 let now=0,slow=0;
 const context=vm.createContext({Date:class extends Date{static now(){return now;}},connectionError,connectionErrorMessages,
  setTimeout:(callback,ms)=>{now+=ms;queueMicrotask(callback);},
  net:{createConnection:()=>{const socket=new EventEmitter();socket.setTimeout=()=>{};socket.destroy=()=>{};
   queueMicrotask(()=>socket.emit(now>=readyAt?'connect':'error',Error('Not ready')));return socket;}},
  child:{exitCode:null},signal:{get aborted(){return now>=abortedAt;}},onSlow:()=>slow++});
 vm.runInContext(source.slice(source.indexOf('async function waitForLocalPort('),source.indexOf('function validateCoreConfig(')),context);
 return {context,now:()=>now,slow:()=>slow};
}
test('slow Windows startup is allowed past five seconds and reports the local phase once',async()=>{
 const f=fixture(6600);await f.context.waitForLocalPort(f.context.child,12345,20000,'sing-box',f.context.signal,f.context.onSlow);
 assert.equal(f.now(),6600);assert.equal(f.slow(),1);
});
test('core startup timeout is a local failure, never a server/network failure',async()=>{
 const f=fixture(Infinity);
 await assert.rejects(f.context.waitForLocalPort(f.context.child,12345,20000,'sing-box',f.context.signal),error=>{
  assert.equal(error.code,'CORE_READY_TIMEOUT');assert.equal(classifyConnectionError(error),'local');return true;
 });
});
test('manual cancellation stops a delayed Windows startup',async()=>{
 const f=fixture(Infinity,400);
 await assert.rejects(f.context.waitForLocalPort(f.context.child,12345,20000,'sing-box',f.context.signal),{code:'ABORT_ERR'});
 assert.equal(f.now(),400);
});
test('journal identifies the Wintun collision without retaining raw core output',()=>{
 assert.match(coreDiagnostic('configure tun interface: (create adapter: Cannot create a file when that file already exists. | open existing adapter: Element not found.)'),/конфликт/);
 assert.match(coreDiagnostic('open interface take too much time to finish!'),/задерживает/);
});

test('network permission errors cannot poison a running TUN or combine across log lines',()=>{
 const context=vm.createContext({Date,coreDiagnostic,isLocalCoreFailure,log:()=>{}});
 vm.runInContext(source.slice(source.indexOf('function readDiagnosticCoreLog('),source.indexOf('function corePath(')),context);
 const child={};
 context.readDiagnosticCoreLog(child,'sing-box',Buffer.from('INFO Wintun initialized\nERROR outbound: dial tcp: operation not permitted\n'));
 assert.equal(child.localFailure,undefined);
 context.readDiagnosticCoreLog(child,'sing-box',Buffer.from('ERROR inbound/tun[tun-in]: packet write: access is denied\n'));
 assert.equal(child.localFailure,undefined);
 context.readDiagnosticCoreLog(child,'sing-box',Buffer.from('FATAL start service: initialize tun: access is denied\n'));
 assert.equal(child.localFailure,true);
 assert.equal(isLocalCoreFailure('configure tun interface: create adapter: Cannot create a file when that file already exists.'),true);
});
