const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vrmDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('vrm:status'),
  toggleFullscreen: () => ipcRenderer.invoke('vrm:fullscreen'),
  chooseSave: () => ipcRenderer.invoke('vrm:save'),
  chooseGame: () => ipcRenderer.invoke('vrm:game-folder'),
  launchGame: () => ipcRenderer.invoke('vrm:launch-game'),
  setAutoLaunch: enabled => ipcRenderer.invoke('vrm:auto-launch', enabled)
}));
