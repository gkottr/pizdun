'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    detectWhisper: () => ipcRenderer.invoke('settings:detectWhisper')
  },
  dialog: {
    pickFile: (opts) => ipcRenderer.invoke('dialog:pickFile', opts || {}),
    pickDir: (opts) => ipcRenderer.invoke('dialog:pickDir', opts || {})
  },
  llm: {
    test: () => ipcRenderer.invoke('llm:test'),
    models: () => ipcRenderer.invoke('llm:models')
  },
  session: {
    start: (title) => ipcRenderer.invoke('session:start', title),
    stop: (opts) => ipcRenderer.invoke('session:stop', opts),
    state: () => ipcRenderer.invoke('session:state'),
    pushAudio: (int16) => ipcRenderer.send('audio:chunk', int16)
  },
  audio: {
    systemStatus: () => ipcRenderer.invoke('audio:systemStatus'),
    requestScreenAccess: () => ipcRenderer.invoke('audio:requestScreenAccess'),
    resetScreenAccess: () => ipcRenderer.invoke('audio:resetScreenAccess'),
    openScreenSettings: () => ipcRenderer.invoke('audio:openScreenSettings')
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    download: (id) => ipcRenderer.invoke('models:download', id),
    cancel: (id) => ipcRenderer.invoke('models:cancel', id),
    remove: (id) => ipcRenderer.invoke('models:remove', id),
    select: (file) => ipcRenderer.invoke('models:select', file)
  },
  archive: {
    list: () => ipcRenderer.invoke('sessions:list'),
    resummarize: (dir) => ipcRenderer.invoke('sessions:resummarize', dir),
    rename: (dir, title) => ipcRenderer.invoke('sessions:rename', { dir, title }),
    delete: (dir) => ipcRenderer.invoke('sessions:delete', dir),
    read: (dir) => ipcRenderer.invoke('sessions:read', dir)
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    showItem: (p) => ipcRenderer.invoke('shell:showItem', p)
  },
  onTranscript: on('evt:transcript'),
  onFacts: on('evt:facts'),
  onStatus: on('evt:status'),
  onError: on('evt:error'),
  onLevel: on('evt:level'),
  onState: on('evt:state'),
  onFinished: on('evt:finished'),
  onModelProgress: on('evt:modelProgress'),
  onFinishing: on('evt:finishing')
});
