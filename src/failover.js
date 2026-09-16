function findNextServer(servers, currentId, failedIds = new Set(), isSupported = () => true) {
  if (!Array.isArray(servers) || servers.length < 2) return undefined;
  const foundIndex = servers.findIndex((item) => item.id === currentId);
  const currentIndex = foundIndex >= 0 ? foundIndex : -1;
  for (let offset = 1; offset < servers.length; offset += 1) {
    const candidate = servers[(currentIndex + offset) % servers.length];
    if (isSupported(candidate) && !failedIds.has(candidate.id)) return candidate;
  }
  return undefined;
}

module.exports = { findNextServer };
