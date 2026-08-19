import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { normalizeSessionData } from "./session-data.mjs";
import { SafeAppError } from "./supabase.mjs";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MAX_LOGIN_SCRIPT_LENGTH = 256_000;
const SNAPSHOT_MARKER_FILE = ".panel-session-snapshot";

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

  const checkSelector = account.tool?.checkSelector;
  if (typeof checkSelector === "string" && checkSelector.length > 0) {
    const authenticated = await page
      .locator(checkSelector)
      .first()
      .waitFor({ state: "visible", timeout: waitForRedirect ? 5_000 : 250 })
      .then(() => true)
      .catch(() => false);
    if (authenticated) return false;
    return true;
  }

  return page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
}

function allowedUrlsFor(account, targetUrl) {
  const extraOrigins = Array.isArray(account.allowedOrigins)
    ? account.allowedOrigins
    : [];
  const values = [
    targetUrl.href,
    account.tool?.baseUrl,
    account.tool?.loginUrl,
    ...extraOrigins
  ];
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

function persistentProfileEnabled(account) {
  return account.persistentProfile === true;
}

export function persistentProfileDirectory(profilesRoot, account, targetUrl) {
  const resolvedRoot = path.resolve(profilesRoot);
  const profileKey = typeof account.profileKey === "string"
    ? account.profileKey.slice(0, 1_024)
    : "default";
  const identity = [
    account.tool?.id || account.tool?.name || targetUrl.hostname,
    account.id,
    profileKey
  ].join("\u0000");
  const digest = crypto.createHash("sha256").update(identity).digest("hex");
  return path.join(resolvedRoot, digest);
}

function snapshotFingerprint(account) {
  const version = account.snapshotVersion ?? account.updatedAt;
  if (typeof version !== "string" || version.length === 0 || version.length > 1_024) return null;
  return crypto.createHash("sha256").update(version).digest("hex");
}

function storedSnapshotFingerprint(profileDirectory) {
  try {
    const value = fs.readFileSync(path.join(profileDirectory, SNAPSHOT_MARKER_FILE), "utf8").trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function saveSnapshotFingerprint(profileDirectory, fingerprint) {
  if (!fingerprint) return;
  try {
    fs.writeFileSync(path.join(profileDirectory, SNAPSHOT_MARKER_FILE), fingerprint, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {
    // O perfil continua utilizável; no próximo acesso o snapshot será reaplicado.
  }
}

function decodeJsonish(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  let current = value.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return fallback;
    }
    if (typeof current !== "string") return current;
  }
  return current;
}

function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function mergeStorageEntries(left = [], right = []) {
  const entries = new Map();
  for (const entry of [...left, ...right]) entries.set(entry.name, entry.value);
  return [...entries].map(([name, value]) => ({ name, value }));
}

function legacyIndexedDbDatabases(decoded) {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const knownKeyPaths = {
    firebaseLocalStorage: "fbase_key",
    sequencesToSend: "sequenceId",
    sessionId: ["sessionId", "sequenceId"],
    events: "id",
    internal: "key",
    keyval: null,
    data: "id"
  };
  const databases = [];
  for (const [databaseName, info] of Object.entries(decoded)) {
    if (!info || typeof info !== "object" || !info.stores || typeof info.stores !== "object") continue;
    const stores = [];
    for (const [storeName, rawItems] of Object.entries(info.stores)) {
      const keyPath = Object.hasOwn(knownKeyPaths, storeName) ? knownKeyPaths[storeName] : null;
      const items = Array.isArray(rawItems)
        ? rawItems
        : rawItems && typeof rawItems === "object"
          ? Object.entries(rawItems).map(([key, value]) => ({ key, value }))
          : [];
      const records = items.map((item) => {
        const key = item && typeof item === "object"
          ? item.fbase_key ?? item.key
          : undefined;
        const value = item && typeof item === "object" && Object.hasOwn(item, "value") &&
          (Object.hasOwn(item, "key") || Object.hasOwn(item, "fbase_key"))
          ? item.value
          : item;
        return {
          ...(key !== undefined ? { key } : {}),
          value
        };
      });
      stores.push({
        name: storeName,
        keyPath,
        autoIncrement: keyPath === null,
        indexes: [],
        records
      });
    }
    databases.push({
      name: databaseName,
      version: Number.isInteger(info.version) && info.version > 0 ? info.version : 1,
      stores
    });
  }
  return databases;
}

function normalizeCompleteIndexedDb(input) {
  const decoded = jsonClone(decodeJsonish(input, null));
  const databases = Array.isArray(decoded)
    ? decoded
    : Array.isArray(decoded?.databases)
      ? decoded.databases
      : legacyIndexedDbDatabases(decoded);
  if (!databases) return [];

  const normalized = [];
  for (const database of databases) {
    if (
      !database ||
      typeof database !== "object" ||
      typeof database.name !== "string" ||
      database.name.trim() === "" ||
      !Number.isInteger(database.version) ||
      database.version < 1 ||
      !Array.isArray(database.stores)
    ) {
      continue;
    }
    const stores = [];
    let complete = true;
    for (const store of database.stores) {
      const keyPathIsValid =
        store?.keyPath === null ||
        typeof store?.keyPath === "string" ||
        (Array.isArray(store?.keyPath) && store.keyPath.every((part) => typeof part === "string"));
      if (
        !store ||
        typeof store !== "object" ||
        typeof store.name !== "string" ||
        store.name.trim() === "" ||
        !Object.hasOwn(store, "keyPath") ||
        !keyPathIsValid ||
        typeof store.autoIncrement !== "boolean" ||
        !Array.isArray(store.records)
      ) {
        complete = false;
        break;
      }
      const indexes = store.indexes === undefined ? [] : store.indexes;
      if (!Array.isArray(indexes) || indexes.some((index) =>
        !index ||
        typeof index.name !== "string" ||
        !(
          typeof index.keyPath === "string" ||
          (Array.isArray(index.keyPath) && index.keyPath.every((part) => typeof part === "string"))
        )
      )) {
        complete = false;
        break;
      }
      const records = [];
      for (const record of store.records) {
        if (!record || typeof record !== "object" || !Object.hasOwn(record, "value")) {
          complete = false;
          break;
        }
        if (store.keyPath === null && !store.autoIncrement && !Object.hasOwn(record, "key")) {
          complete = false;
          break;
        }
        records.push({
          ...(Object.hasOwn(record, "key") ? { key: record.key } : {}),
          value: record.value
        });
      }
      if (!complete) break;
      stores.push({
        name: store.name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: indexes.map((index) => ({
          name: index.name,
          keyPath: index.keyPath,
          unique: index.unique === true,
          multiEntry: index.multiEntry === true
        })),
        records
      });
    }
    if (complete) {
      normalized.push({
        name: database.name,
        version: database.version,
        stores
      });
    }
  }
  return normalized;
}

function normalizeOriginStorage(account, targetUrl, allowedUrls, normalizedSession) {
  const origins = new Map();
  const add = ({ origin, local = [], session = [], indexedDB = [] }) => {
    const existing = origins.get(origin) || {
      origin,
      local: [],
      session: [],
      indexedDB: []
    };
    existing.local = mergeStorageEntries(existing.local, local);
    existing.session = mergeStorageEntries(existing.session, session);
    if (indexedDB.length > 0) existing.indexedDB = indexedDB;
    origins.set(origin, existing);
  };

  add({
    origin: targetUrl.origin,
    local: normalizedSession.localStorage,
    session: normalizedSession.sessionStorage,
    indexedDB: normalizeCompleteIndexedDb(
      account.indexedDB ?? account.indexedDb ?? account.indexed_db
    )
  });

  const configuredOrigins = decodeJsonish(account.origins, []);
  if (!Array.isArray(configuredOrigins)) return [...origins.values()];
  const allowed = new Set(allowedUrls.map((item) => item.origin));
  for (const configured of configuredOrigins) {
    if (!configured || typeof configured !== "object") continue;
    let parsed;
    try {
      parsed = validateLaunchUrl(configured.origin);
    } catch {
      continue;
    }
    if (!allowed.has(parsed.origin)) continue;
    const session = normalizeSessionData(
      {
        cookies: [],
        local_storage: configured.localStorage ?? configured.local_storage,
        session_storage: configured.sessionStorage ?? configured.session_storage
      },
      { defaultUrl: parsed.href }
    );
    add({
      origin: parsed.origin,
      local: session.localStorage,
      session: session.sessionStorage,
      indexedDB: normalizeCompleteIndexedDb(
        configured.indexedDB ?? configured.indexedDb ?? configured.indexed_db
      )
    });
  }
  return [...origins.values()];
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

function cookieIdentity(cookie) {
  const host = cookieHostname(cookie);
  if (!host || typeof cookie.name !== "string") return null;
  let cookiePath = cookie.path;
  if (!cookiePath && cookie.url) {
    try {
      const pathname = new URL(cookie.url).pathname;
      cookiePath = pathname.endsWith("/")
        ? pathname
        : pathname.slice(0, pathname.lastIndexOf("/") + 1);
    } catch {
      cookiePath = "/";
    }
  }
  return `${cookie.name}\u0000${host}\u0000${cookiePath || "/"}`;
}

async function cookiesToSeed(context, cookies, snapshotPolicy) {
  if (snapshotPolicy === "replace") return cookies;
  const currentCookies = await context.cookies().catch(() => []);
  const existing = new Set(currentCookies.map(cookieIdentity).filter(Boolean));
  return cookies.filter((cookie) => !existing.has(cookieIdentity(cookie)));
}

function trustedScriptSource(account) {
  if (account.trustedLoginScript !== true) return null;
  const source = account.loginScript ?? account.tool?.loginScript;
  if (
    typeof source !== "string" ||
    source.trim() === "" ||
    source.length > MAX_LOGIN_SCRIPT_LENGTH ||
    source.includes("\u0000")
  ) {
    return null;
  }
  return source;
}

function scriptArguments(account) {
  const supplied = account.loginArgs && typeof account.loginArgs === "object"
    ? account.loginArgs
    : account.credentials && typeof account.credentials === "object"
      ? account.credentials
      : {};
  const safePrimitive = (value) =>
    ["string", "number", "boolean"].includes(typeof value) ? String(value) : "";
  return {
    email: safePrimitive(supplied.email ?? account.email),
    username: safePrimitive(
      supplied.username ?? supplied.email ?? account.username ?? account.email
    ),
    password: safePrimitive(supplied.password ?? account.password)
  };
}

async function executeTrustedLoginScript(page, account) {
  const scriptSource = trustedScriptSource(account);
  if (!scriptSource) return { executed: false, succeeded: false };
  const scriptArgs = scriptArguments(account);
  try {
    await page.evaluate(async ({ source, args }) => {
      // Placeholders are converted to argument references; credential values
      // are never concatenated into source code or an exception message.
      const quoted = /(["'])\{\{\s*(email|username|password)\s*\}\}\1/gi;
      const plain = /\{\{\s*(email|username|password)\s*\}\}/gi;
      const compiled = source
        .replace(quoted, (_match, _quote, name) => `__args.${name.toLowerCase()}`)
        .replace(plain, (_match, name) => `__args.${name.toLowerCase()}`);
      const runner = new Function(
        "__args",
        `"use strict"; const email = __args.email; const username = __args.username; const password = __args.password; return (async () => { ${compiled}\n })();`
      );
      await runner(Object.freeze({ ...args }));
    }, { source: scriptSource, args: scriptArgs });
    return { executed: true, succeeded: true };
  } catch {
    return { executed: true, succeeded: false };
  }
}

function initializeOriginStorage(payloads) {
  const payload = payloads.find((item) => item.origin === globalThis.location.origin);
  if (!payload) return;

  if (payload.replace) {
    try { globalThis.localStorage.clear(); } catch {}
    try { globalThis.sessionStorage.clear(); } catch {}
  }

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
    if ("onblocked" in request) request.onblocked = () => reject(new Error("blocked"));
  });
  const valueAtKeyPath = (value, keyPath) => {
    if (Array.isArray(keyPath)) {
      const parts = keyPath.map((part) => valueAtKeyPath(value, part));
      return parts.some((part) => part === undefined) ? undefined : parts;
    }
    return String(keyPath).split(".").reduce(
      (current, part) => current?.[part],
      value
    );
  };
  const valueWithKey = (value, keyPath, key) => {
    if (key === undefined || keyPath === null) return value;
    const cloned = value && typeof value === "object"
      ? structuredClone(value)
      : {};
    if (Array.isArray(keyPath)) {
      if (!Array.isArray(key)) return cloned;
      keyPath.forEach((part, index) => {
        if (!part.includes(".")) cloned[part] = key[index];
      });
      return cloned;
    }
    if (!keyPath.includes(".")) cloned[keyPath] = key;
    return cloned;
  };

  const restoreIndexedDB = async () => {
    let recordsApplied = 0;
    if (payload.replace) {
      const databaseNames = new Set(payload.indexedDB.map((database) => database.name));
      if (typeof globalThis.indexedDB.databases === "function") {
        const existing = await globalThis.indexedDB.databases().catch(() => []);
        for (const database of existing) {
          if (database?.name) databaseNames.add(database.name);
        }
      }
      for (const databaseName of databaseNames) {
        await requestResult(globalThis.indexedDB.deleteDatabase(databaseName)).catch(() => undefined);
      }
    }
    for (const databaseDefinition of payload.indexedDB) {
      const openRequest = globalThis.indexedDB.open(
        databaseDefinition.name,
        databaseDefinition.version
      );
      openRequest.onupgradeneeded = () => {
        const database = openRequest.result;
        const upgradeTransaction = openRequest.transaction;
        for (const storeDefinition of databaseDefinition.stores) {
          let store;
          if (database.objectStoreNames.contains(storeDefinition.name)) {
            store = upgradeTransaction.objectStore(storeDefinition.name);
          } else {
            store = database.createObjectStore(storeDefinition.name, {
              keyPath: storeDefinition.keyPath,
              autoIncrement: storeDefinition.autoIncrement
            });
          }
          for (const indexDefinition of storeDefinition.indexes) {
            if (!store.indexNames.contains(indexDefinition.name)) {
              store.createIndex(indexDefinition.name, indexDefinition.keyPath, {
                unique: indexDefinition.unique,
                multiEntry: indexDefinition.multiEntry
              });
            }
          }
        }
      };

      let database;
      try {
        database = await requestResult(openRequest);
      } catch {
        continue;
      }
      const availableStores = databaseDefinition.stores.filter((definition) =>
        database.objectStoreNames.contains(definition.name)
      );
      if (availableStores.length === 0) {
        database.close();
        continue;
      }

      const transaction = database.transaction(
        availableStores.map((definition) => definition.name),
        "readwrite"
      );
      const transactionDone = new Promise((resolve) => {
        transaction.oncomplete = resolve;
        transaction.onerror = resolve;
        transaction.onabort = resolve;
      });
      for (const storeDefinition of availableStores) {
        const store = transaction.objectStore(storeDefinition.name);
        let initiallyEmpty = null;
        for (const record of storeDefinition.records) {
          try {
            let value = valueWithKey(
              record.value,
              storeDefinition.keyPath,
              record.key
            );
            const inlineKey = storeDefinition.keyPath === null
              ? undefined
              : valueAtKeyPath(value, storeDefinition.keyPath);
            const recordKey = storeDefinition.keyPath === null
              ? record.key
              : inlineKey;

            if (!payload.replace) {
              if (recordKey !== undefined) {
                const current = await requestResult(store.get(recordKey));
                if (current !== undefined) continue;
              } else {
                if (initiallyEmpty === null) {
                  initiallyEmpty = await requestResult(store.count()) === 0;
                }
                if (!initiallyEmpty) continue;
              }
            }

            if (storeDefinition.keyPath === null && record.key !== undefined) {
              await requestResult(store.put(value, record.key));
            } else {
              await requestResult(store.put(value));
            }
            recordsApplied += 1;
          } catch {
            // Um registro inválido não deve impedir os demais.
          }
        }
      }
      await transactionDone;
      database.close();
    }
    return recordsApplied;
  };

  globalThis.__painelStorageReady = restoreIndexedDB().catch(() => 0);
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
    this.closing = false;
    this.closePromise = null;
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
    const userDataDir = persistentProfileDirectory(
      this.profilesRoot,
      account,
      targetUrl
    );
    fs.mkdirSync(userDataDir, { recursive: true });
    const baseOptions = {
      ...contextOptions,
      headless: this.headless,
      chromiumSandbox: true
    };

    if (this.channel !== "chromium") {
      try {
        return await chromium.launchPersistentContext(userDataDir, {
          ...baseOptions,
          channel: this.channel
        });
      } catch {
        // A descoberta por caminho abaixo cobre instalações fora do registro.
      }
    }

    for (const executablePath of installedBrowserCandidates(this.channel)) {
      try {
        return await chromium.launchPersistentContext(userDataDir, {
          ...baseOptions,
          executablePath
        });
      } catch {
        // Tenta o próximo navegador sem propagar opções ou dados de sessão.
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
    if (this.closing) {
      throw new SafeAppError("O navegador está sendo encerrado.", "BROWSER_CLOSING");
    }
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
    if (this.closing) {
      throw new SafeAppError("O navegador está sendo encerrado.", "BROWSER_CLOSING");
    }
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
        cookiesPreserved: 0,
        cookiesSkipped: 0,
        storageKeysApplied: 0,
        indexedDbRecordsApplied: 0,
        navigationWarning: false,
        persistentProfile: persistentProfileEnabled(account),
        loginScriptExecuted: false,
        loginScriptSucceeded: false,
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
    const profileDirectory = persistentProfile
      ? persistentProfileDirectory(this.profilesRoot, account, targetUrl)
      : null;
    const fingerprint = snapshotFingerprint(account);
    const snapshotChanged = Boolean(
      persistentProfile && fingerprint &&
      storedSnapshotFingerprint(profileDirectory) !== fingerprint
    );
    const snapshotPolicy = account.snapshotPolicy === "replace" || snapshotChanged
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

      if (snapshotPolicy === "replace") await context.clearCookies().catch(() => undefined);
      const seedCookies = await cookiesToSeed(context, scopedCookies, snapshotPolicy);
      const cookieResult = await addCookiesSafely(context, seedCookies);
      const originStorage = normalizeOriginStorage(
        account,
        targetUrl,
        allowedUrls,
        normalized
      );
      const storagePayload = originStorage.map((origin) => ({
        ...origin,
        replace: snapshotPolicy === "replace"
      }));

      let storageInitializer = null;
      if (storagePayload.some((origin) =>
        origin.local.length > 0 ||
        origin.session.length > 0 ||
        origin.indexedDB.length > 0
      )) {
        storageInitializer = await context.addInitScript(
          initializeOriginStorage,
          storagePayload
        );
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

      for (const openedPage of context.pages()) {
        openedPage.once("close", closeContextWhenEmpty);
      }
      const page = persistentProfile
        ? context.pages().find((candidate) =>
          !candidate.isClosed() && candidate.url() === "about:blank"
        ) || await context.newPage()
        : await context.newPage();

      let navigationWarning = false;
      let indexedDbRecordsApplied = 0;
      for (const origin of originStorage) {
        if (
          origin.origin === targetUrl.origin ||
          (origin.local.length === 0 && origin.session.length === 0 && origin.indexedDB.length === 0)
        ) {
          continue;
        }
        const seedUrl = origin.origin + "/.well-known/painel-session-seed";
        const urlMatcher = (url) => url.href === seedUrl;
        const routeHandler = (route) => route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: "<!doctype html><title>session</title>"
        });
        try {
          await page.route(urlMatcher, routeHandler);
          await page.goto(seedUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
          indexedDbRecordsApplied += await page.evaluate(async () =>
            await Promise.race([
              globalThis.__painelStorageReady || Promise.resolve(0),
              new Promise((resolve) => setTimeout(() => resolve(0), 5_000))
            ])
          ).catch(() => 0);
        } catch {
          navigationWarning = true;
        } finally {
          await page.unroute(urlMatcher, routeHandler).catch(() => undefined);
        }
      }
      try {
        await page.goto(targetUrl.href, {
          waitUntil: "domcontentloaded",
          timeout: 45_000
        });
      } catch {
        navigationWarning = true;
      } finally {
        if (!page.isClosed()) {
          indexedDbRecordsApplied += await page.evaluate(async () =>
            await Promise.race([
              globalThis.__painelStorageReady || Promise.resolve(0),
              new Promise((resolve) => setTimeout(() => resolve(0), 5_000))
            ])
          ).catch(() => 0);
        }
        if (storageInitializer) {
          await storageInitializer.dispose().catch(() => undefined);
        }
      }

      if (indexedDbRecordsApplied > 0 && !page.isClosed()) {
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
        } catch {
          navigationWarning = true;
        }
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

      if (persistentProfile && fingerprint) {
        saveSnapshotFingerprint(profileDirectory, fingerprint);
      }

      return {
        reused: false,
        cookiesApplied: cookieResult.applied,
        cookiesPreserved: scopedCookies.length - seedCookies.length,
        cookiesSkipped:
          normalized.diagnostics.filter(
            (item) =>
              item.field === "cookies" && item.code !== "cookie_invalid_same_site"
          ).length +
          cookiesRejectedByScope +
          cookieResult.failed,
        storageKeysApplied:
          originStorage.reduce(
            (total, origin) => total + origin.local.length + origin.session.length,
            0
          ),
        indexedDbRecordsApplied,
        navigationWarning,
        persistentProfile,
        loginScriptExecuted: loginScriptResult.executed,
        loginScriptSucceeded: loginScriptResult.succeeded,
        loginDetected
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
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled([
        ...this.accountOperations.values(),
        ...(this.launchPromise ? [this.launchPromise] : [])
      ]);
      const contexts = [...this.contexts.values()];
      this.contexts.clear();
      await Promise.allSettled(contexts.map((context) => context.close()));
      if (this.browser) {
        const browser = this.browser;
        this.browser = null;
        await browser.close().catch(() => undefined);
      }
    })();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
      this.closing = false;
    }
  }
}

export const __testing = {
  allowedUrlsFor,
  cookieHostname,
  safeUserAgent,
  normalizeCompleteIndexedDb,
  normalizeOriginStorage,
  executeTrustedLoginScript,
  cookiesToSeed
};
