const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('temple', {
  getState: () => ipcRenderer.invoke('state:get'),
  setSubscription: (subscription) => ipcRenderer.invoke('subscription:set', subscription),
  updateSubscription: (subscription) => ipcRenderer.invoke('subscription:update', subscription),
  deleteSubscription: (id) => ipcRenderer.invoke('subscription:delete', id),
  selectSubscription: (id) => ipcRenderer.invoke('subscription:select', id),
  organizeSubscriptions: (change) => ipcRenderer.invoke('subscription:organize', change),
  refreshSubscription: () => ipcRenderer.invoke('subscription:refresh'),
  importSubscriptionFile: (image) => ipcRenderer.invoke('subscription:import-file', image),
  diagnoseNetwork: () => ipcRenderer.invoke('network:diagnose'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  rollbackUpdate: () => ipcRenderer.invoke('update:rollback'),
  pingServers: () => ipcRenderer.invoke('servers:ping'),
  cancelRecovery: () => ipcRenderer.invoke('recovery:cancel'),
  addApplications: () => ipcRenderer.invoke('apps:add'),
  removeApplication: (path) => ipcRenderer.invoke('apps:remove', path),
  toggleApplication: (application) => ipcRenderer.invoke('apps:toggle', application),
  updateSettings: (update) => ipcRenderer.invoke('settings:update', update),
  toggleTunnel: () => ipcRenderer.invoke('tunnel:toggle'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  onStateChanged: (callback) => ipcRenderer.on('state:changed', (_event, value) => callback(value))
});
