// Preload bridge — the only surface the renderer can touch.
const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("codepal", {
  // app / connection
  info: () => ipcRenderer.invoke("app:info"),
  balance: () => ipcRenderer.invoke("app:balance"),
  setToken: (token) => ipcRenderer.invoke("app:set-token", token),
  clearToken: () => ipcRenderer.invoke("app:clear-token"),
  portalConnect: () => ipcRenderer.invoke("app:portal-connect"),
  portalCancel: () => ipcRenderer.send("app:portal-cancel"),
  openDashboard: () => ipcRenderer.send("app:open-dashboard"),

  // workspace files (confined to the open folder by the main process)
  openWorkspace: () => ipcRenderer.invoke("workspace:open"),
  list: (dir) => ipcRenderer.invoke("fs:list", dir),
  read: (file) => ipcRenderer.invoke("fs:read", file),
  write: (file, content) => ipcRenderer.invoke("fs:write", file, content),
  stat: (file) => ipcRenderer.invoke("fs:stat", file),
  create: (file, kind) => ipcRenderer.invoke("fs:create", file, kind),

  // agent session
  send: (args) => ipcRenderer.invoke("session:send", args),
  abort: () => ipcRenderer.invoke("session:abort"),
  reset: () => ipcRenderer.invoke("session:reset"),
  setModel: (id) => ipcRenderer.invoke("session:set-model", id),
  respondApproval: (id, approved, reason) => ipcRenderer.send("approval:respond", { id, approved, reason }),
  onEvent: (cb) => subscribe("session:event", cb),
  onApproval: (cb) => subscribe("approval:request", cb),
  onApprovalCancelled: (cb) => subscribe("approval:cancelled", cb),
  onDemoUser: (cb) => subscribe("demo:user", cb),
  onMenu: (cb) => subscribe("menu:command", cb),
});
