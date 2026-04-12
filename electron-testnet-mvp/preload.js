const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('synorix', {
  configGet: () => ipcRenderer.invoke('config:get'),
  configSet: (cfg) => ipcRenderer.invoke('config:set', cfg),
  binariesResolve: () => ipcRenderer.invoke('binaries:resolve'),
  pathsGet: () => ipcRenderer.invoke('paths:get'),
  pickBinary: (title) => ipcRenderer.invoke('dialog:pickBinary', title),
  pickBinDirectory: (title) => ipcRenderer.invoke('dialog:pickBinDirectory', title),
  openDatadir: () => ipcRenderer.invoke('shell:openDatadir'),
  openReleases: () => ipcRenderer.invoke('shell:openReleases'),

  nodeStart: (synorixdPath, synorixCliPath) =>
    ipcRenderer.invoke('node:start', { synorixdPath, synorixCliPath }),
  nodeStop: (synorixCliPath) => ipcRenderer.invoke('node:stop', { synorixCliPath }),

  onNodeHealth: (callback) => {
    ipcRenderer.on('node:health', (_event, payload) => {
      callback(payload);
    });
  },

  getBlockchainInfo: (synorixCliPath) =>
    ipcRenderer.invoke('rpc:getblockchaininfo', { synorixCliPath }),
  checkNodeReady: (synorixCliPath) =>
    ipcRenderer.invoke('rpc:checkNodeReady', { synorixCliPath }),
  waitForRPCReady: (synorixCliPath) =>
    ipcRenderer.invoke('rpc:waitForRPCReady', { synorixCliPath }),
  getNetworkInfo: (synorixCliPath) =>
    ipcRenderer.invoke('rpc:getnetworkinfo', { synorixCliPath }),
  getConnectionCount: (synorixCliPath) =>
    ipcRenderer.invoke('rpc:getconnectioncount', { synorixCliPath }),

  walletCreate: (synorixCliPath) => ipcRenderer.invoke('wallet:create', { synorixCliPath }),
  walletNewAddress: (synorixCliPath) =>
    ipcRenderer.invoke('wallet:newaddress', { synorixCliPath }),
  walletBalance: (synorixCliPath) => ipcRenderer.invoke('wallet:balance', { synorixCliPath }),
  walletBalances: (synorixCliPath) => ipcRenderer.invoke('wallet:balances', { synorixCliPath }),
  walletSend: (synorixCliPath, address, amount) =>
    ipcRenderer.invoke('wallet:send', { synorixCliPath, address, amount }),
  walletInfo: () => ipcRenderer.invoke('wallet:info'),
  walletCreateNamed: (synorixCliPath, walletName) =>
    ipcRenderer.invoke('wallet:createNamed', { synorixCliPath, walletName }),
  walletList: () => ipcRenderer.invoke('wallet:list'),
  walletSwitch: (synorixCliPath, walletId) =>
    ipcRenderer.invoke('wallet:switch', { synorixCliPath, walletId }),
  walletTransactions: (synorixCliPath, count) =>
    ipcRenderer.invoke('wallet:transactions', { synorixCliPath, count }),

  miningGenerate: (synorixCliPath, nblocks, address) =>
    ipcRenderer.invoke('mining:generatetoaddress', { synorixCliPath, nblocks, address }),
});
