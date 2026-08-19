"use strict";

const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) {
    const error = new Error(result?.error?.message || "A operação não pôde ser concluída.");
    error.code = result?.error?.code || "IPC_ERROR";
    throw error;
  }
  return result.data;
}

contextBridge.exposeInMainWorld(
  "accountPanel",
  Object.freeze({
    getAuthStatus: () => invoke("auth:status"),
    reauthenticate: () => invoke("auth:reauthenticate"),
    login: ({ email, password }) =>
      invoke("auth:login", {
        email: String(email || "").trim(),
        password: String(password || "")
      }),
    logout: () => invoke("auth:logout"),
    listTools: () => invoke("tools:list"),
    openTool: (toolId) => invoke("tools:open", String(toolId || "")),
    restartTool: (toolId) => invoke("tools:restart", String(toolId || "")),
    reportTool: ({ toolId, confirmationWord }) =>
      invoke("tools:report", {
        toolId: String(toolId || ""),
        confirmationWord: String(confirmationWord || "")
      }),
    pollTools: () => invoke("tools:poll")
  })
);
