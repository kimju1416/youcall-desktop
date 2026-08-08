// 렌더러에 안전하게 노출하는 API — TeacherDesk2/preload.js와 동일한 contextBridge 패턴.
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('yc', {
  getSettings: () => inv('yc:get-settings'),
  saveSettings: patch => inv('yc:save-settings', patch),
  getTts: text => inv('yc:get-tts', text),
  testConnection: (webAppUrl, grade, classNum) => inv('yc:test-connection', { webAppUrl, grade, classNum }),
  quit: () => inv('yc:quit'),

  // 메인 → 렌더러 이벤트 (전부 main.js의 상태 머신이 보내주는 값을 그대로 그린다)
  onSettings: cb => ipcRenderer.on('yc:settings', (e, s) => cb(s)),
  onBoard: cb => ipcRenderer.on('yc:board', (e, data) => cb(data)),
  onAlert: cb => ipcRenderer.on('yc:alert', (e, data) => cb(data)),
  onStandby: cb => ipcRenderer.on('yc:standby', () => cb())
});
