import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { AuthSessionManager, AuthStore, AuthStoreError } from "./auth-store.mjs";
import { BrowserManager } from "./browser-manager.mjs";
import { loadConfig } from "./config.mjs";
import { HodProApi, HodProApiError } from "./hodpro-api.mjs";
import { getDeviceId } from "./hwid.mjs";
import { RichToolsService } from "./rich-tools-service.mjs";
import { SafeAppError } from "./supabase.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.resolve(MODULE_DIR, "../public/index.html");
const SPLASH_PATH = path.resolve(MODULE_DIR, "../public/splash.html");
const PRELOAD_PATH = path.resolve(MODULE_DIR, "preload.cjs");
const UI_URL = pathToFileURL(UI_PATH).href;
const SPLASH_URL = pathToFileURL(SPLASH_PATH).href;
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = electron;

let mainWindow = null;
let browserManager = null;
let service = null;
let serviceInitializationPromise = null;
let shutdownStarted = false;
let automaticCredentials = null;
let automaticLoginPromise = null;

function assertTrustedSender(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame?.url !== UI_URL
  ) {
    throw new SafeAppError("Origem da solicitação recusada.", "UNTRUSTED_SENDER");
  }
}

function publicError(error) {
  if (
    error instanceof SafeAppError ||
    error instanceof HodProApiError ||
    error instanceof AuthStoreError
  ) {
    return { message: error.message, code: error.code };
  }
  return {
    message: "Ocorreu um erro inesperado. Feche o painel e tente novamente.",
    code: "UNEXPECTED_ERROR"
  };
}

function validateAutomaticCredentials(value) {
  const email = typeof value?.email === "string" ? value.email.trim() : "";
  const password = typeof value?.password === "string" ? value.password : "";
  if (!email || !email.includes("@") || !password) return null;
  return Object.freeze({ email, password });
}

function loadAutomaticCredentials() {
  if (automaticCredentials) return automaticCredentials;

  const fromEnvironment = validateAutomaticCredentials({
    email: process.env.PANEL_AUTO_LOGIN_EMAIL,
    password: process.env.PANEL_AUTO_LOGIN_PASSWORD
  });
  if (fromEnvironment) {
    automaticCredentials = fromEnvironment;
    return automaticCredentials;
  }

  const candidates = [
    path.join(process.resourcesPath || "", "auto-login.json"),
    path.resolve(MODULE_DIR, "../.auto-login.json"),
    path.join(path.dirname(process.execPath), ".auto-login.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const credentials = validateAutomaticCredentials(parsed);
      if (credentials) {
        automaticCredentials = credentials;
        return automaticCredentials;
      }
    } catch {
      // Nunca registra o conteúdo do arquivo de credenciais.
    }
  }

  throw new SafeAppError(
    "O login automático ainda não foi configurado nesta cópia do aplicativo.",
    "AUTO_LOGIN_NOT_CONFIGURED"
  );
}

function isAuthenticationFailure(error) {
  const code = String(error?.code || "").toUpperCase();
  return [
    "AUTH_REQUIRED",
    "AUTH_EXPIRED",
    "UNAUTHENTICATED",
    "NOT_AUTHENTICATED",
    "SESSION_EXPIRED",
    "GATEWAY_HTTP_401",
    "GATEWAY_HTTP_403"
  ].includes(code) || [401, 403].includes(error?.status);
}

function ensureServiceInitialized() {
  if (!serviceInitializationPromise) {
    serviceInitializationPromise = service.initialize().catch((error) => {
      serviceInitializationPromise = null;
      throw error;
    });
  }
  return serviceInitializationPromise;
}

async function automaticLogin() {
  if (automaticLoginPromise) return automaticLoginPromise;
  automaticLoginPromise = (async () => {
    await ensureServiceInitialized();
    const credentials = loadAutomaticCredentials();
    const previousStatus = service.getAuthStatus();
    try {
      return await service.login(credentials.email, credentials.password);
    } catch (error) {
      // Se a autenticação nova falhou por rede e havia uma sessão válida salva,
      // tenta restaurar o par anterior para não deixar o painel indisponível.
      if (previousStatus?.authenticated && !isAuthenticationFailure(error)) {
        try {
          await service.initialize();
          const restored = service.getAuthStatus();
          if (restored?.authenticated) return restored;
        } catch {
          // Propaga o erro original abaixo.
        }
      }
      throw error;
    }
  })().finally(() => {
    automaticLoginPromise = null;
  });
  return automaticLoginPromise;
}

async function withAutomaticRelogin(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isAuthenticationFailure(error)) throw error;
    await automaticLogin();
    return operation();
  }
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

function registerHandlers() {
  handle("auth:status", () => service.getAuthStatus());
  handle("auth:reauthenticate", () => automaticLogin());
  handle("tools:list", () => withAutomaticRelogin(() => service.listTools()));
  handle("tools:open", (toolId) => withAutomaticRelogin(() => service.openTool(toolId)));
  handle("tools:restart", (toolId) => withAutomaticRelogin(() => service.restartTool(toolId)));
  handle("tools:report", (input) =>
    withAutomaticRelogin(() => service.reportTool(input?.toolId, input?.confirmationWord))
  );
  handle("tools:poll", () => withAutomaticRelogin(() => service.pollTools()));
}

function createWindow(initialPath = SPLASH_PATH) {
  const isTestMode = process.env.PANEL_TEST_MODE === "1";
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#07111f",
    title: "Ferramentas Amigos do Rich",
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
    if (targetUrl !== UI_URL && targetUrl !== SPLASH_URL) event.preventDefault();
  });
  if (!isTestMode) window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.loadFile(initialPath);
  return window;
}

async function loadAuthenticatedPanel(window) {
  await automaticLogin();
  if (!window || window.isDestroyed()) return;
  await window.loadFile(UI_PATH);
}

async function boot() {
  try {
    const config = loadConfig();
    if (config.dataMode !== "hodpro") {
      throw new Error("Este painel usa o fluxo autenticado hodpro. Ajuste PANEL_DATA_MODE=hodpro.");
    }

    const api = new HodProApi({
      baseUrl: config.gatewayUrl,
      timeoutMs: config.requestTimeoutMs
    });
    const authStore = new AuthStore({ app, safeStorage });
    const auth = new AuthSessionManager({ apiClient: api, store: authStore });
    const deviceId = await getDeviceId();

    browserManager = new BrowserManager({
      channel: config.browserChannel,
      profilesRoot: path.join(app.getPath("userData"), "tool-profiles")
    });
    service = new RichToolsService({
      api,
      auth,
      browserManager,
      deviceId,
      appVersion: app.getVersion()
    });

    registerHandlers();
    mainWindow = createWindow(SPLASH_PATH);

    loadAuthenticatedPanel(mainWindow).catch((error) => {
      const message = error instanceof Error && typeof error.message === "string"
        ? error.message
        : "Não foi possível conectar ao serviço.";
      dialog.showErrorBox("Ferramentas Amigos do Rich", message);
      app.quit();
    });

    if (process.env.PANEL_TEST_MODE === "1") {
      const autoExitMs = Number.parseInt(process.env.PANEL_AUTO_EXIT_MS || "", 10);
      if (Number.isFinite(autoExitMs) && autoExitMs >= 250 && autoExitMs <= 30_000) {
        setTimeout(() => app.quit(), autoExitMs);
      }
    }
  } catch (error) {
    const message = error instanceof Error && typeof error.message === "string"
      ? error.message
      : "Não foi possível iniciar o aplicativo.";
    dialog.showErrorBox("Ferramentas Amigos do Rich", message);
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
  if (mainWindow || !service) return;
  const status = service.getAuthStatus();
  mainWindow = createWindow(status?.authenticated ? UI_PATH : SPLASH_PATH);
  if (!status?.authenticated) {
    loadAuthenticatedPanel(mainWindow).catch((error) => {
      const message = error instanceof Error ? error.message : "Não foi possível conectar ao serviço.";
      dialog.showErrorBox("Ferramentas Amigos do Rich", message);
      app.quit();
    });
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
  if (shutdownStarted || !browserManager) return;
  shutdownStarted = true;
  event.preventDefault();
  browserManager.close().catch(() => undefined).finally(() => app.quit());
});
