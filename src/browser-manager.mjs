import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { normalizeSessionData } from "./session-data.mjs";
import { SafeAppError } from "./supabase.mjs";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

export function validateLaunchUrl(value) {
  if (!value) {
    throw new SafeAppError("A ferramenta não possui uma URL de acesso.", "MISSING_LAUNCH_URL");
  }

  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new SafeAppError("A ferramenta possui uma URL inválida.", "INVALID_LAUNCH_URL");
  }

  const allowedProtocol =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isLoopback(parsed.hostname));
  if (!allowedProtocol || parsed.username || parsed.password) {
    throw new SafeAppError(
      "A URL de acesso precisa usar HTTPS.",
      "UNSAFE_LAUNCH_URL"
    );
  }
  return parsed;
}

function parseComparableUrl(value) {
  try {
    const parsed = new URL(String(value));
    return {
      origin: parsed.origin,
      path: parsed.pathname.replace(/\/+$/, "") || "/",
      route: parsed.pathname + parsed.hash
    };
  } catch {
    return null;
  }
}

export function isLoginDestination(finalUrl, { loginUrl } = {}) {
  const finalLocation = parseComparableUrl(finalUrl);
  if (!finalLocation) return false;

  const configuredLogin = parseComparableUrl(loginUrl);
  if (
    configuredLogin &&
    configuredLogin.origin === finalLocation.origin &&
    configuredLogin.path === finalLocation.path
  ) {
    return true;
  }

  return /(?:^|[\/#])(auth\/)?(?:login|signin|sign-in)(?:[\/?#]|$)/i.test(
    finalLocation.route
  );
}

async function detectLoginPage(page, account, { waitForRedirect = false } = {}) {
  const options = { loginUrl: account.tool?.loginUrl };
  if (isLoginDestination(page.url(), options)) return true;

  if (waitForRedirect) {
    const redirected = await page
      .waitForURL((url) => isLoginDestination(url.href, options), {
        timeout: 1_200
      })
      .then(() => true)
      .catch(() => false);
    if (redirected) return true;
  }

  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

function allowedUrlsFor(account, targetUrl) {
  const values = [targetUrl.href, account.tool?.baseUrl, account.tool?.loginUrl];
  const urls = [];
  for (const value of values) {
    if (!value) continue;
    try {
      const parsed = validateLaunchUrl(value);
      if (!urls.some((item) => item.origin === parsed.origin)) urls.push(parsed);
    } catch {
      // Uma URL secundária inválida não amplia a lista de origens permitidas.
    }
  }
  return urls;
}

function cookieHostname(cookie) {
  if (cookie.url) {
    try {
      return new URL(cookie.url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  if (cookie.domain) return String(cookie.domain).replace(/^\./, "").toLowerCase();
  return null;
}

export function cookieMatchesAllowedHosts(cookie, allowedHosts) {
  const cookieHost = cookieHostname(cookie);
  if (!cookieHost) return false;
  return allowedHosts.some(
    (allowedHost) =>
      allowedHost === cookieHost || allowedHost.endsWith("." + cookieHost)
  );
}

function safeUserAgent(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 10 || trimmed.length > 1000 || CONTROL_CHARACTER.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function installedBrowserCandidates(channel) {
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env.LOCALAPPDATA;
  const chrome = [
    programFiles && path.join(programFiles, "Google/Chrome/Application/chrome.exe"),
    programFilesX86 && path.join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
    localAppData && path.join(localAppData, "Google/Chrome/Application/chrome.exe")
  ];
  const edge = [
    programFiles && path.join(programFiles, "Microsoft/Edge/Application/msedge.exe"),
    programFilesX86 && path.join(programFilesX86, "Microsoft/Edge/Application/msedge.exe")
  ];
  const ordered = channel === "msedge" ? [...edge, ...chrome] : [...chrome, ...edge];
  return ordered.filter((candidate) => candidate && fs.existsSync(candidate));
}

async function addCookieChunk(context, cookies) {
  if (cookies.length === 0) return { applied: 0, failed: 0 };
  try {
    await context.addCookies(cookies);
    return { applied: cookies.length, failed: 0 };
  } catch {
    let applied = 0;
    let failed = 0;
    for (const cookie of cookies) {
      try {
        await context.addCookies([cookie]);
        applied += 1;
      } catch {
        failed += 1;
      }
    }
    return { applied, failed };
  }
}

async function addCookiesSafely(context, cookies) {
  let applied = 0;
  let failed = 0;
  for (let index = 0; index < cookies.length; index += 100) {
    const result = await addCookieChunk(context, cookies.slice(index, index + 100));
    applied += result.applied;
    failed += result.failed;
  }
  return { applied, failed };
}

export class BrowserManager {
  constructor({ channel = "chrome", headless = false, profilesRoot } = {}) {
    this.channel = channel;
    this.headless = headless;
    this.profilesRoot = path.resolve(
      profilesRoot ||
      path.join(
        process.env.LOCALAPPDATA || os.tmpdir(),
        "painel-de-contas",
        "browser-profiles"
      )
    );
    this.browser = null;
    this.contexts = new Map();
    this.accountOperations = new Map();
    this.pendingOpens = new Map();
    this.pendingRestarts = new Map();
    this.launchPromise = null;
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = this.launchBrowser();
    try {
      this.browser = await this.launchPromise;
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.contexts.clear();
      });
      return this.browser;
    } finally {
      this.launchPromise = null;
    }
  }

  async launchBrowser() {
    const baseOptions = {
      headless: this.headless,
      chromiumSandbox: true
    };

    if (this.channel !== "chromium") {
      try {
        return await chromium.launch({ ...baseOptions, channel: this.channel });
      } catch {
        // A descoberta por caminho abaixo cobre instalações fora do registro.
      }
    }

    for (const executablePath of installedBrowserCandidates(this.channel)) {
      try {
        return await chromium.launch({ ...baseOptions, executablePath });
      } catch {
        // Tenta o próximo navegador instalado, sem registrar argumentos sensíveis.
      }
    }

    throw new SafeAppError(
      "Não foi possível iniciar o Chrome ou Edge instalado.",
      "BROWSER_LAUNCH_FAILED"
    );
  }

  async launchPersistentContext(account, targetUrl, contextOptions) {
    const profilePath = profileDirectory(this.profilesRoot, account, targetUrl);
    fs.mkdirSync(profilePath, { recursive: true });
    const baseOptions = {
      ...contextOptions,
      headless: this.headless,
      chromiumSandbox: true
    };

    if (this.channel !== "chromium") {
      try {
        return await chromium.launchPersistentContext(profilePath, {
          ...baseOptions,
          channel: this.channel
        });
      } catch {
        // A descoberta por caminho abaixo cobre instalações fora do registro.
      }
    }

    for (const executablePath of installedBrowserCandidates(this.channel)) {
      try {
        return await chromium.launchPersistentContext(profilePath, {
          ...baseOptions,
          executablePath
        });
      } catch {
        // Tenta o próximo navegador sem incluir configuração sensível no erro.
      }
    }

    throw new SafeAppError(
      "Não foi possível iniciar o perfil isolado no Chrome ou Edge.",
      "PERSISTENT_BROWSER_LAUNCH_FAILED"
    );
  }

  async bringExistingToFront(accountId) {
    const existing = this.contexts.get(accountId);
    if (!existing) return false;
    const page = existing.pages().find((candidate) => !candidate.isClosed());
    if (!page) {
      this.contexts.delete(accountId);
      await existing.close().catch(() => undefined);
      return false;
    }
    try {
      await page.bringToFront();
      return true;
    } catch {
      this.contexts.delete(accountId);
      await existing.close().catch(() => undefined);
      return false;
    }
  }

  enqueueAccountOperation(accountId, work) {
    const previous = this.accountOperations.get(accountId) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    this.accountOperations.set(accountId, operation);
    return operation.finally(() => {
      if (this.accountOperations.get(accountId) === operation) {
        this.accountOperations.delete(accountId);
      }
    });
  }

  async closeAccountContext(accountId) {
    const existing = this.contexts.get(accountId);
    if (!existing) return false;
    if (this.contexts.get(accountId) === existing) {
      this.contexts.delete(accountId);
    }
    await existing.close().catch(() => undefined);
    return true;
  }

  async openAccount(account) {
    const pending = this.pendingOpens.get(account.id);
    if (pending) return pending;

    const operation = this.enqueueAccountOperation(account.id, () =>
      this.openAccountOnce(account)
    );
    this.pendingOpens.set(account.id, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingOpens.get(account.id) === operation) {
        this.pendingOpens.delete(account.id);
      }
    }
  }

  async restartAccount(accountId, loadFreshAccount) {
    const pending = this.pendingRestarts.get(accountId);
    if (pending) return pending;
    if (typeof loadFreshAccount !== "function") {
      throw new SafeAppError(
        "Não foi possível atualizar os dados dessa conta.",
        "INVALID_SESSION_LOADER"
      );
    }

    const operation = this.enqueueAccountOperation(accountId, async () => {
      await this.closeAccountContext(accountId);
      const account = await loadFreshAccount();
      if (!account || account.id !== accountId) {
        throw new SafeAppError(
          "A conta atualizada não corresponde à conta solicitada.",
          "ACCOUNT_MISMATCH"
        );
      }
      const result = await this.openAccountOnce(account, { reuseExisting: false });
      return {
        ...result,
        restarted: true,
        sessionUpdatedAt: account.updatedAt || null
      };
    });

    this.pendingRestarts.set(accountId, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingRestarts.get(accountId) === operation) {
        this.pendingRestarts.delete(accountId);
      }
    }
  }

  async openAccountOnce(account, { reuseExisting = true } = {}) {
    if (reuseExisting && await this.bringExistingToFront(account.id)) {
      const existingPage = this.contexts
        .get(account.id)
        ?.pages()
        .find((candidate) => !candidate.isClosed());
      return {
        reused: true,
        cookiesApplied: 0,
        cookiesSkipped: 0,
        storageKeysApplied: 0,
        navigationWarning: false,
        loginDetected: existingPage
          ? await detectLoginPage(existingPage, account)
          : false
      };
    }

    const targetUrl = validateLaunchUrl(account.tool?.baseUrl || account.tool?.loginUrl);
    const allowedUrls = allowedUrlsFor(account, targetUrl);
    const allowedHosts = allowedUrls.map((url) => url.hostname.toLowerCase());

    const normalized = normalizeSessionData(
      {
        cookies: account.cookies,
        local_storage: account.localStorage,
        session_storage: account.sessionStorage,
        proxy_url: account.proxyUrl
      },
      { defaultUrl: targetUrl.href }
    );

    if (account.proxyUrl && !normalized.proxy) {
      throw new SafeAppError(
        "O proxy configurado para essa conta é inválido; o acesso foi cancelado.",
        "INVALID_ACCOUNT_PROXY"
      );
    }

    const scopedCookies = normalized.cookies.filter((cookie) =>
      cookieMatchesAllowedHosts(cookie, allowedHosts)
    );
    const cookiesRejectedByScope = normalized.cookies.length - scopedCookies.length;

    const persistentProfile = persistentProfileEnabled(account);
    const snapshotPolicy = account.snapshotPolicy === "replace"
      ? "replace"
      : "fill-missing";
    let context;
    try {
      const contextOptions = {
        locale: "pt-BR",
        timezoneId: "America/Sao_Paulo",
        viewport: null
      };
      const userAgent = safeUserAgent(account.userAgent);
      if (userAgent) contextOptions.userAgent = userAgent;
      if (normalized.proxy) contextOptions.proxy = normalized.proxy;

      if (persistentProfile) {
        context = await this.launchPersistentContext(account, targetUrl, contextOptions);
      } else {
        const browser = await this.ensureBrowser();
        context = await browser.newContext(contextOptions);
      }
      this.contexts.set(account.id, context);
      context.once("close", () => {
        if (this.contexts.get(account.id) === context) {
          this.contexts.delete(account.id);
        }
      });

      const seedCookies = await cookiesToSeed(context, scopedCookies, snapshotPolicy);
      const cookieResult = await addCookiesSafely(context, seedCookies);
      const originStorage = normalizeOriginStorage(
        account,
        targetUrl,
        allowedUrls,
        normalized
      );
      const storagePayload = storagePayloadFor(account, originStorage, snapshotPolicy);

      let storageInitializer = null;
      if (storagePayload.some((item) =>
        item.local.length > 0 || item.session.length > 0 || item.indexedDB
      )) {
        storageInitializer = await context.addInitScript((payloads) => {
          const payload = payloads.find((item) => item.origin === globalThis.location.origin);
          if (!payload) return;

          let alreadySeeded = false;
          try {
            alreadySeeded = globalThis.sessionStorage.getItem(payload.marker) === "1";
            if (!alreadySeeded) globalThis.sessionStorage.setItem(payload.marker, "1");
          } catch {
            // Storage bloqueado: ainda tentamos os demais mecanismos uma vez.
          }
          if (alreadySeeded) return;

          for (const entry of payload.local) {
            try {
              if (payload.replace || globalThis.localStorage.getItem(entry.name) === null) {
                globalThis.localStorage.setItem(entry.name, entry.value);
              }
            } catch {
              // Uma chave inválida não deve impedir as demais.
            }
          }
          for (const entry of payload.session) {
            try {
              if (payload.replace || globalThis.sessionStorage.getItem(entry.name) === null) {
                globalThis.sessionStorage.setItem(entry.name, entry.value);
              }
            } catch {
              // Uma chave inválida não deve impedir as demais.
            }
          }

          const requestResult = (request) => new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const knownKeyPaths = {
            firebaseLocalStorage: "fbase_key",
            sequencesToSend: "sequenceId",
            sessionId: ["sessionId", "sequenceId"],
            events: "id",
            internal: "key",
            keyval: null,
            data: "id"
          };
          const restoreIndexedDB = async () => {
            if (!payload.indexedDB || typeof payload.indexedDB !== "object") return;
            for (const [databaseName, databaseInfo] of Object.entries(payload.indexedDB)) {
              if (!databaseInfo || typeof databaseInfo !== "object") continue;
              const stores = databaseInfo.stores && typeof databaseInfo.stores === "object"
                ? databaseInfo.stores
                : {};
              const openRequest = globalThis.indexedDB.open(
                databaseName,
                Number.isInteger(databaseInfo.version) && databaseInfo.version > 0
                  ? databaseInfo.version
                  : 1
              );
              openRequest.onupgradeneeded = () => {
                const database = openRequest.result;
                for (const [storeName, rawDefinition] of Object.entries(stores)) {
                  if (database.objectStoreNames.contains(storeName)) continue;
                  const definition = rawDefinition && !Array.isArray(rawDefinition) &&
                    typeof rawDefinition === "object" &&
                    ("records" in rawDefinition || "items" in rawDefinition || "data" in rawDefinition)
                    ? rawDefinition
                    : null;
                  const keyPath = definition && "keyPath" in definition
                    ? definition.keyPath
                    : knownKeyPaths[storeName];
                  const options = {};
                  if (keyPath !== null && keyPath !== undefined) options.keyPath = keyPath;
                  if (definition?.autoIncrement === true || keyPath === null) {
                    options.autoIncrement = true;
                  }
                  database.createObjectStore(storeName, options);
                }
              };
              let database;
              try {
                database = await requestResult(openRequest);
              } catch {
                continue;
              }
              const existingStores = Object.keys(stores).filter((name) =>
                database.objectStoreNames.contains(name)
              );
              if (existingStores.length === 0) {
                database.close();
                continue;
              }
              const transaction = database.transaction(existingStores, "readwrite");
              for (const storeName of existingStores) {
                const store = transaction.objectStore(storeName);
                const rawDefinition = stores[storeName];
                const definition = rawDefinition && !Array.isArray(rawDefinition) &&
                  typeof rawDefinition === "object" &&
                  ("records" in rawDefinition || "items" in rawDefinition || "data" in rawDefinition)
                  ? rawDefinition
                  : null;
                const rawItems = definition
                  ? definition.records ?? definition.items ?? definition.data ?? []
                  : rawDefinition;
                const items = Array.isArray(rawItems)
                  ? rawItems
                  : rawItems && typeof rawItems === "object"
                    ? Object.entries(rawItems).map(([key, value]) => ({ key, value }))
                    : [];
                for (const item of items) {
                  try {
                    const wrapped = item && typeof item === "object" &&
                      "value" in item && ("key" in item || "fbase_key" in item);
                    const key = item?.fbase_key ?? item?.key;
                    let value = wrapped ? item.value : item;
                    if (store.keyPath) {
                      if (!value || typeof value !== "object") {
                        value = { [store.keyPath]: key, value };
                      } else if (key !== undefined && value[store.keyPath] === undefined) {
                        value = { ...value, [store.keyPath]: key };
                      }
                      const recordKey = Array.isArray(store.keyPath)
                        ? store.keyPath.map((part) => value?.[part])
                        : value?.[store.keyPath];
                      if (!payload.replace && recordKey !== undefined) {
                        const current = await requestResult(store.get(recordKey));
                        if (current !== undefined) continue;
                      }
                      store.put(value);
                    } else if (key !== undefined) {
                      if (!payload.replace) {
                        const current = await requestResult(store.get(key));
                        if (current !== undefined) continue;
                      }
                      store.put(value, key);
                    } else {
                      if (!payload.replace && await requestResult(store.count()) > 0) continue;
                      store.put(value);
                    }
                  } catch {
                    // Um registro inválido não deve impedir os demais.
                  }
                }
              }
              await new Promise((resolve) => {
                transaction.oncomplete = resolve;
                transaction.onerror = resolve;
                transaction.onabort = resolve;
              });
              database.close();
            }
          };
          globalThis.__painelStorageReady = restoreIndexedDB().catch(() => undefined);
        }, storagePayload);
      }

      const closeContextWhenEmpty = () => {
        queueMicrotask(() => {
          if (
            !context.isClosed() &&
            this.contexts.get(account.id) === context &&
            context.pages().length === 0
          ) {
            context.close().catch(() => undefined);
          }
        });
      };
      context.on("page", (openedPage) => {
        openedPage.once("close", closeContextWhenEmpty);
      });

      const page = await context.newPage();

      let navigationWarning = false;
      try {
        await page.goto(targetUrl.href, {
          waitUntil: "domcontentloaded",
          timeout: 45_000
        });
      } catch {
        navigationWarning = true;
      }

      let loginDetected = await detectLoginPage(page, account, {
        waitForRedirect: !navigationWarning
      });
      let loginScriptResult = { executed: false, succeeded: false };
      if (loginDetected) {
        loginScriptResult = await executeTrustedLoginScript(page, account);
        if (loginScriptResult.succeeded) {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await page.waitForTimeout(250).catch(() => undefined);
            loginDetected = await detectLoginPage(page, account);
            if (!loginDetected) break;
          }
        }
      }

      return {
        reused: false,
        cookiesApplied: cookieResult.applied,
        cookiesSkipped:
          normalized.diagnostics.filter(
            (item) =>
              item.field === "cookies" && item.code !== "cookie_invalid_same_site"
          ).length +
          cookiesRejectedByScope +
          cookieResult.failed,
        storageKeysApplied:
          originStorage.reduce(
            (total, item) => total + item.local.length + item.session.length,
            0
          ),
        navigationWarning,
        loginDetected,
        persistentProfile,
        loginScriptExecuted: loginScriptResult.executed,
        loginScriptSucceeded: loginScriptResult.succeeded
      };
    } catch (error) {
      if (context) await context.close().catch(() => undefined);
      this.contexts.delete(account.id);
      if (error instanceof SafeAppError) throw error;
      throw new SafeAppError(
        "Não foi possível preparar a sessão no navegador.",
        "SESSION_PREPARATION_FAILED"
      );
    }
  }

  async close() {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.allSettled(contexts.map((context) => context.close()));
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
    }
  }
}

export const __testing = {
  allowedUrlsFor,
  cookieHostname,
  safeUserAgent
};
