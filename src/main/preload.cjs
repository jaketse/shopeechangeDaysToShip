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

  batchChangeDaysToShip: (accountId, days, selectedProductIds = null) => ipcRenderer.invoke('change:batch', accountId, days, selectedProductIds),
  getScheduleTasks: (accountId) => ipcRenderer.invoke('schedule:tasks:get', accountId),
  createScheduleTask: (accountId, payload) => ipcRenderer.invoke('schedule:task:create', accountId, payload),
  updateScheduleTask: (taskId, payload) => ipcRenderer.invoke('schedule:task:update', taskId, payload),
  saveScheduleTaskDraft: (taskId, payload) => ipcRenderer.invoke('schedule:task:save-draft', taskId, payload),
  setScheduleTaskActive: (taskId, isActive) => ipcRenderer.invoke('schedule:task:set-active', taskId, isActive),
  deleteScheduleTask: (taskId) => ipcRenderer.invoke('schedule:task:delete', taskId),
  createScheduleRule: (taskId, payload) => ipcRenderer.invoke('schedule:rule:create', taskId, payload),
  updateScheduleRule: (ruleId, payload) => ipcRenderer.invoke('schedule:rule:update', ruleId, payload),
  deleteScheduleRule: (ruleId) => ipcRenderer.invoke('schedule:rule:delete', ruleId),
  getScheduleProductCandidates: (accountId, taskId) => ipcRenderer.invoke('schedule:products:candidates', accountId, taskId),
  addScheduleProducts: (taskId, productIds) => ipcRenderer.invoke('schedule:products:add', taskId, productIds),
  removeScheduleProducts: (taskId, productIds) => ipcRenderer.invoke('schedule:products:remove', taskId, productIds),
  getScheduleTaskLogs: (taskId, limit = 300, groupId = null) => ipcRenderer.invoke('schedule:task:logs:get', taskId, limit, groupId),
  getScheduleTaskLogGroups: (taskId) => ipcRenderer.invoke('schedule:task:log-groups', taskId),
  getProxySettings: () => ipcRenderer.invoke('proxy:get'),
  saveProxySettings: (payload) => ipcRenderer.invoke('proxy:set', payload),
  onOpenProxySettings: (handler) => {
    const fn = () => handler?.();
    ipcRenderer.on('help:open-proxy-settings', fn);
    return () => ipcRenderer.removeListener('help:open-proxy-settings', fn);
  },
  confirmDialog: (opts) => ipcRenderer.invoke('ui:confirm', opts),
  getLogs: (accountId, tab, taskId = null) => ipcRenderer.invoke('logs:get', accountId, tab, taskId),
  getLogGroups: (accountId, tab) => ipcRenderer.invoke('logs:groups', accountId, tab),
  isTaskRunning: (accountId) => ipcRenderer.invoke('task:running', accountId),
  stopTask: (accountId) => ipcRenderer.invoke('task:stop', accountId),
});
