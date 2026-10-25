// 12-源码照搬 · 最小外壳 preload：只暴露安全的、必要的能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kun', {
  app: {
    scenarios: () => ipcRenderer.invoke('app:scenarios'),
    config: () => ipcRenderer.invoke('app:config'),
    dirs: () => ipcRenderer.invoke('app:dirs'),
    dshRoot: () => ipcRenderer.invoke('app:dshRoot'),
    openPath: (p) => ipcRenderer.invoke('app:openPath', p),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    load: () => ipcRenderer.invoke('app:load'),
    home: () => ipcRenderer.invoke('app:home'),
    balance: () => ipcRenderer.invoke('app:balance'),
    version: () => ipcRenderer.invoke('app:version'),
    injectMemory: () => ipcRenderer.invoke('mem:inject'),
    disks: () => ipcRenderer.invoke('disk:list'),
  },
  fs: {
    list: (dir) => ipcRenderer.invoke('fs:list', dir),
    read: (p) => ipcRenderer.invoke('fs:read', p),
  },
  webai: { open: (key, url, title) => ipcRenderer.invoke('webai:open', key, url, title) },
  win: {
    control: (action) => ipcRenderer.invoke('win:control', action),
  },
  topbar: {
    // 本壳没有快照系统：明确返回 supported:false，让「回退」显示"未接入"而不是假按钮
    snapshots: () => Promise.resolve({ rows: [], total: 0, supported: false }),
  },
});
