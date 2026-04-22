const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onData: (cb) => ipcRenderer.on('data', (_e, data) => cb(data)),
  goto: (i) => ipcRenderer.invoke('goto', i),
  create: () => ipcRenderer.invoke('create'),
  rename: (i, name) => ipcRenderer.invoke('rename', i, name),
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),
});
