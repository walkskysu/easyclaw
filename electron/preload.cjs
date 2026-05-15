const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getServerUrl: () => ipcRenderer.invoke('client:getServerUrl'),
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (config) => ipcRenderer.invoke('config:save', config),
    refreshAvailableSkills: () => ipcRenderer.invoke('skills:refresh'),
    // WeChat bridge
    onWechatMessage: (callback) => ipcRenderer.on('wechat:incoming', (_event, data) => callback(data)),
    sendToWechat: (userId, text) => ipcRenderer.invoke('wechat:send', { userId, text }),
})
