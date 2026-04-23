const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onData: (cb) => ipcRenderer.on('data', (_e, data) => cb(data)),
  onVisibility: (cb) => ipcRenderer.on('visibility', (_e, v) => cb(v)),
  goto: (i) => ipcRenderer.invoke('goto', i),
  create: () => ipcRenderer.invoke('create'),
  rename: (i, name) => ipcRenderer.invoke('rename', i, name),
  delete: (i) => ipcRenderer.invoke('delete', i),
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),
});
