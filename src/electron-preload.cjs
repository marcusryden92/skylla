const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('skylla', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
