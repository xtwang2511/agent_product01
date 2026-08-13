'use strict';

/**
 * zhhs01-desktop · preload（安全桥）
 *
 * 通过 contextBridge 向渲染进程的 window.electronAPI 暴露受控本地能力。
 * 渲染进程（Web 工作台）不直接持有 Node / Electron 模块，仅通过此桥调用。
 */

const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

const api = {
  isElectron: true,
  initialDir: os.homedir(),

  pickFiles: () => ipcRenderer.invoke('local:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('local:pickFolder'),
  readFile: (p, opts) => ipcRenderer.invoke('local:readFile', p, opts),
  readDir: (p) => ipcRenderer.invoke('local:readDir', p),
  openPath: (p) => ipcRenderer.invoke('local:openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('local:showInFolder', p),
  writeFile: (p, c) => ipcRenderer.invoke('local:writeFile', p, c),
  dirParent: (p) => ipcRenderer.invoke('local:dirParent', p),
  runCommand: (cmd, cwd) => ipcRenderer.invoke('local:runCommand', cmd, cwd),
  osInfo: () => ipcRenderer.invoke('local:osInfo')
};

contextBridge.exposeInMainWorld('electronAPI', api);
