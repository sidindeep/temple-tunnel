const FRESH_MS = 120000;
const INTERVAL_MS = 30000;

function nextReserve(pool, now = Date.now()) {
  if (!pool?.probePorts || now - (pool.activeConfirmedAt || 0) > 20000) return;
  return [...pool.probePorts.keys()].filter(id=>id!==pool.activeId)
    .filter(id=>now - (pool.checks.get(id)?.checkedAt || 0) >= INTERVAL_MS)
    .sort((a,b)=>(pool.checks.get(a)?.checkedAt || 0)-(pool.checks.get(b)?.checkedAt || 0))[0];
}
function preferPrepared(candidates, pool, now = Date.now()) {
  const fresh = id => pool?.checks.get(id)?.status === 'ok' && now - pool.checks.get(id).checkedAt < FRESH_MS;
  return [...candidates].sort((a,b)=>Number(Boolean(fresh(b.id)))-Number(Boolean(fresh(a.id))));
}
module.exports={nextReserve,preferPrepared,FRESH_MS,INTERVAL_MS};
