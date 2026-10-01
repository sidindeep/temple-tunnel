const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('processPicker', {
  list: () => ipcRenderer.invoke('apps:list-running'),
  add: (process) => ipcRenderer.invoke('apps:add-process', process),
  close: () => ipcRenderer.invoke('apps:close-process-picker')
});
