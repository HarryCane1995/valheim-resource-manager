const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vrmDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('vrm:status'),
  toggleFullscreen: () => ipcRenderer.invoke('vrm:fullscreen'),
  chooseSave: () => ipcRenderer.invoke('vrm:save')
}));
