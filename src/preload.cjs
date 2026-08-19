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
    listAccounts: () => invoke("accounts:list"),
    openAccount: (accountId) => invoke("accounts:open", accountId),
    restartAccount: (accountId) => invoke("accounts:restart", accountId)
  })
);
