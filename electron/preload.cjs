const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: (config) => ipcRenderer.invoke('config:save', config),
    getConfigPath: () => ipcRenderer.invoke('config:path'),
    refreshAvailableSkills: () => ipcRenderer.invoke('skills:refresh'),
    getToolConfiguration: () => ipcRenderer.invoke('tools:getConfiguration'),
    getToolDefinitions: () => ipcRenderer.invoke('tools:getDefinitions'),
    invokeTool: (name, args) => ipcRenderer.invoke('tools:invoke', { name, arguments: args }),
    logWrite: (filename, entry) => ipcRenderer.invoke('log:write', { filename, entry }),
    // WeChat bridge
    onWechatMessage: (callback) => ipcRenderer.on('wechat:incoming', (_event, data) => callback(data)),
    sendToWechat: (userId, text) => ipcRenderer.invoke('wechat:send', { userId, text }),
})
