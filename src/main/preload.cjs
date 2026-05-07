const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAccounts: () => ipcRenderer.invoke('accounts:get'),
  addAccount: (shopId, cookieJson) => ipcRenderer.invoke('accounts:add', shopId, cookieJson),
  updateAccountCookie: (id, cookieJson) => ipcRenderer.invoke('accounts:update-cookie', id, cookieJson),
  deleteAccount: (id) => ipcRenderer.invoke('accounts:delete', id),
  validateAccount: (id) => ipcRenderer.invoke('accounts:validate', id),

  fetchProducts: (accountId) => ipcRenderer.invoke('products:fetch', accountId),
  getProducts: (accountId) => ipcRenderer.invoke('products:get', accountId),
  addToChangeList: (accountId, productIds) => ipcRenderer.invoke('change-list:add', accountId, productIds),
  removeFromChangeList: (accountId, productIds) => ipcRenderer.invoke('change-list:remove', accountId, productIds),
  getChangeList: (accountId) => ipcRenderer.invoke('change-list:get', accountId),

  batchChangeDaysToShip: (accountId, days) => ipcRenderer.invoke('change:batch', accountId, days),
  getLogs: (accountId, tab) => ipcRenderer.invoke('logs:get', accountId, tab),
  isTaskRunning: (accountId) => ipcRenderer.invoke('task:running', accountId),
});
