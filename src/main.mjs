import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { BrowserManager } from "./browser-manager.mjs";
import { loadConfig } from "./config.mjs";
import {
  isAccountLaunchable,
  SafeAppError,
  SupabaseRepository
} from "./supabase.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.resolve(MODULE_DIR, "../public/index.html");
const PRELOAD_PATH = path.resolve(MODULE_DIR, "preload.cjs");
const { app, BrowserWindow, dialog, ipcMain } = electron;

let mainWindow = null;
let browserManager = null;
let repository = null;
let config = null;
let shutdownStarted = false;

function assertTrustedSender(event) {
  const expectedUrl = pathToFileURL(UI_PATH).href;
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame?.url !== expectedUrl
  ) {
    throw new SafeAppError("Origem da solicitação recusada.", "UNTRUSTED_SENDER");
  }
}

function publicError(error) {
  if (error instanceof SafeAppError) {
    return { message: error.message, code: error.code };
  }
  return {
    message: "Ocorreu um erro inesperado. Feche o painel e tente novamente.",
    code: "UNEXPECTED_ERROR"
  };
}

function handle(channel, operation) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedSender(event);
      return { ok: true, data: await operation(...args) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
}

async function loadLaunchableAccount(accountId) {
  const account = await repository.getAccountSession(accountId);
  if (!account.isActive) {
    throw new SafeAppError("Essa conta está marcada como inativa.", "ACCOUNT_INACTIVE");
  }
  if (!isAccountLaunchable(account)) {
    throw new SafeAppError(
      "Essa conta não possui uma URL de acesso segura.",
      "MISSING_LAUNCH_URL"
    );
  }
  return account;
}

function registerHandlers() {
  handle("accounts:list", async () => {
    const accounts = await repository.listAccounts();
    return {
      accounts,
      connection: {
        authenticated: Boolean(config.accessToken),
        source: config.configSource
      }
    };
  });

  handle("accounts:open", async (accountId) => {
    const account = await loadLaunchableAccount(accountId);
    const result = await browserManager.openAccount(account);
    return {
      ...result,
      sessionUpdatedAt: result.reused ? null : account.updatedAt
    };
  });

  handle("accounts:restart", async (accountId) => {
    return browserManager.restartAccount(accountId, () =>
      loadLaunchableAccount(accountId)
    );
  });
}

function createWindow() {
  const isTestMode = process.env.PANEL_TEST_MODE === "1";
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#07111f",
    title: "Painel de Contas",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const expectedUrl = pathToFileURL(UI_PATH).href;
    if (targetUrl !== expectedUrl) event.preventDefault();
  });
  if (!isTestMode) window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.loadFile(UI_PATH);
  return window;
}

async function boot() {
  try {
    config = loadConfig();
    repository = new SupabaseRepository(config);
    browserManager = new BrowserManager({ channel: config.browserChannel });
    registerHandlers();
    mainWindow = createWindow();
    if (process.env.PANEL_TEST_MODE === "1") {
      const autoExitMs = Number.parseInt(process.env.PANEL_AUTO_EXIT_MS || "", 10);
      if (Number.isFinite(autoExitMs) && autoExitMs >= 250 && autoExitMs <= 30_000) {
        setTimeout(() => app.quit(), autoExitMs);
      }
    }
  } catch (error) {
    const safeConfigMessage =
      error instanceof Error && typeof error.message === "string"
        ? error.message
        : "Não foi possível iniciar o aplicativo.";
    dialog.showErrorBox("Painel de Contas", safeConfigMessage);
    app.quit();
  }
}

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(boot);
}

app.on("activate", () => {
  if (!mainWindow && repository) mainWindow = createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !browserManager) return;
  shutdownStarted = true;
  event.preventDefault();
  browserManager
    .close()
    .catch(() => undefined)
    .finally(() => app.quit());
});
