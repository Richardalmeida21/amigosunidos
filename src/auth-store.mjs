import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STORE_FILENAME = "hodpro-auth-session.enc";
const STORE_VERSION = 1;
const DEFAULT_REFRESH_MARGIN_MS = 60_000;

export class AuthStoreError extends Error {
  constructor(message, code = "AUTH_STORE_ERROR") {
    super(message);
    this.name = "AuthStoreError";
    this.code = code;
  }
}

function normalizeSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthStoreError("A sessão de autenticação é inválida.", "INVALID_SESSION");
  }
  if (typeof value.accessToken !== "string" || !value.accessToken) {
    throw new AuthStoreError("A sessão não possui token de acesso.", "INVALID_SESSION");
  }
  if (typeof value.refreshToken !== "string" || !value.refreshToken) {
    throw new AuthStoreError("A sessão não possui token de renovação.", "INVALID_SESSION");
  }
  if (!value.user || typeof value.user !== "object" || Array.isArray(value.user)) {
    throw new AuthStoreError("A sessão não possui um usuário válido.", "INVALID_SESSION");
  }

  const expiresAt = Number(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new AuthStoreError("A expiração da sessão é inválida.", "INVALID_SESSION");
  }

  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    user: value.user,
    expiresAt
  };
}

function jwtExpiresAt(accessToken) {
  if (typeof accessToken !== "string") return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const seconds = Number(claims?.exp);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function resolveExpiresAt(authResponse, now) {
  const candidates = [];
  const expiresIn = Number(authResponse?.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    candidates.push(now + expiresIn * 1000);
  }
  const jwtExpiry = jwtExpiresAt(authResponse?.accessToken);
  if (jwtExpiry) candidates.push(jwtExpiry);
  return candidates.length ? Math.min(...candidates) : now;
}

function safeUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const metadata =
    user.user_metadata && typeof user.user_metadata === "object"
      ? user.user_metadata
      : null;
  return Object.freeze({
    id: typeof user.id === "string" ? user.id : null,
    email: typeof user.email === "string" ? user.email : null,
    fullName:
      typeof user.full_name === "string"
        ? user.full_name
        : typeof metadata?.full_name === "string"
          ? metadata.full_name
          : null
  });
}

function isDefinitiveRefreshFailure(error) {
  return (
    [400, 401, 403].includes(error?.status) ||
    [
      "INVALID_AUTH_RESPONSE",
      "INVALID_SESSION",
      "WRITE_FAILED",
      "ENCRYPT_FAILED",
      "ENCRYPTION_UNAVAILABLE"
    ].includes(error?.code)
  );
}

export class AuthStore {
  constructor({
    app,
    safeStorage,
    fsImpl = fs,
    randomId = () => crypto.randomUUID(),
    filename = STORE_FILENAME
  } = {}) {
    if (!app || typeof app.getPath !== "function") {
      throw new AuthStoreError("O aplicativo Electron não foi informado.", "INVALID_APP");
    }
    const canEncrypt = typeof safeStorage?.encryptStringAsync === "function" ||
      typeof safeStorage?.encryptString === "function";
    const canDecrypt = typeof safeStorage?.decryptStringAsync === "function" ||
      typeof safeStorage?.decryptString === "function";
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !canEncrypt || !canDecrypt) {
      throw new AuthStoreError("O armazenamento seguro não foi informado.", "INVALID_SAFE_STORAGE");
    }
    if (path.basename(filename) !== filename) {
      throw new AuthStoreError("O nome do arquivo de sessão é inválido.", "INVALID_FILENAME");
    }

    const userDataPath = app.getPath("userData");
    if (typeof userDataPath !== "string" || !userDataPath) {
      throw new AuthStoreError("A pasta de dados do aplicativo é inválida.", "INVALID_APP");
    }

    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.randomId = randomId;
    this.directory = path.resolve(userDataPath);
    this.filePath = path.join(this.directory, filename);
    this.writeQueue = Promise.resolve();
  }

  async encryptionMode() {
    if (
      typeof this.safeStorage.isAsyncEncryptionAvailable === "function" &&
      typeof this.safeStorage.encryptStringAsync === "function" &&
      typeof this.safeStorage.decryptStringAsync === "function" &&
      await this.safeStorage.isAsyncEncryptionAvailable()
    ) {
      return "async";
    }
    if (
      typeof this.safeStorage.encryptString === "function" &&
      typeof this.safeStorage.decryptString === "function" &&
      await this.safeStorage.isEncryptionAvailable()
    ) {
      return "sync";
    }
    throw new AuthStoreError(
      "A criptografia segura do sistema operacional não está disponível.",
      "ENCRYPTION_UNAVAILABLE"
    );
  }

  mutate(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.catch(() => undefined);
    return pending;
  }

  async save(value) {
    const session = normalizeSession(value);
    const encryptionMode = await this.encryptionMode();

    let encrypted;
    try {
      const plaintext = JSON.stringify({ version: STORE_VERSION, ...session });
      encrypted = encryptionMode === "async"
        ? await this.safeStorage.encryptStringAsync(plaintext)
        : await this.safeStorage.encryptString(plaintext);
    } catch {
      throw new AuthStoreError("Não foi possível criptografar a sessão.", "ENCRYPT_FAILED");
    }
    if (!(encrypted instanceof Uint8Array) || encrypted.byteLength === 0) {
      throw new AuthStoreError("A criptografia retornou dados inválidos.", "ENCRYPT_FAILED");
    }
    const encryptedBuffer = Buffer.from(encrypted);

    return this.mutate(async () => {
      await this.fs.mkdir(this.directory, { recursive: true });
      const temporaryPath = this.filePath + "." + this.randomId() + ".tmp";
      let handle;
      try {
        handle = await this.fs.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(encryptedBuffer);
        await handle.sync();
        await handle.close();
        handle = null;
        await this.fs.rename(temporaryPath, this.filePath);
      } catch {
        throw new AuthStoreError("Não foi possível salvar a sessão.", "WRITE_FAILED");
      } finally {
        if (handle) await handle.close().catch(() => undefined);
        await this.fs.unlink(temporaryPath).catch(() => undefined);
      }
    });
  }

  async load() {
    await this.writeQueue;
    const encryptionMode = await this.encryptionMode();

    let encrypted;
    try {
      encrypted = await this.fs.readFile(this.filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new AuthStoreError("Não foi possível ler a sessão salva.", "READ_FAILED");
    }

    try {
      const decrypted = encryptionMode === "async"
        ? await this.safeStorage.decryptStringAsync(encrypted)
        : { result: await this.safeStorage.decryptString(encrypted), shouldReEncrypt: false };
      const parsed = JSON.parse(decrypted.result);
      if (parsed.version !== STORE_VERSION) throw new Error("unsupported version");
      const session = Object.freeze(normalizeSession(parsed));
      if (decrypted.shouldReEncrypt === true) await this.save(session);
      return session;
    } catch {
      throw new AuthStoreError(
        "A sessão salva está corrompida ou não pode ser descriptografada.",
        "CORRUPT_SESSION"
      );
    }
  }

  async clear() {
    return this.mutate(async () => {
      try {
        await this.fs.unlink(this.filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new AuthStoreError("Não foi possível apagar a sessão.", "CLEAR_FAILED");
        }
      }
    });
  }
}

export class AuthSessionManager {
  constructor({
    apiClient,
    store,
    now = () => Date.now(),
    refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS
  } = {}) {
    if (
      !apiClient ||
      typeof apiClient.login !== "function" ||
      typeof apiClient.refresh !== "function" ||
      typeof apiClient.signout !== "function"
    ) {
      throw new AuthStoreError("O cliente de autenticação é inválido.", "INVALID_API_CLIENT");
    }
    if (
      !store ||
      typeof store.save !== "function" ||
      typeof store.load !== "function" ||
      typeof store.clear !== "function"
    ) {
      throw new AuthStoreError("O cofre de autenticação é inválido.", "INVALID_STORE");
    }
    if (!Number.isFinite(refreshMarginMs) || refreshMarginMs < 0) {
      throw new AuthStoreError("A margem de renovação é inválida.", "INVALID_REFRESH_MARGIN");
    }

    this.apiClient = apiClient;
    this.store = store;
    this.now = now;
    this.refreshMarginMs = refreshMarginMs;
    this.session = null;
    this.refreshPromise = null;
    this.generation = 0;
    this.preferredEmail = null;
  }

  getStatus() {
    const session = this.session;
    if (!session) {
      return Object.freeze({
        authenticated: false,
        user: null,
        preferredEmail: this.preferredEmail,
        expiresAt: null,
        needsRefresh: false
      });
    }
    return Object.freeze({
      authenticated: true,
      user: safeUser(session.user),
      preferredEmail: safeUser(session.user)?.email || this.preferredEmail,
      expiresAt: session.expiresAt,
      needsRefresh: this.now() + this.refreshMarginMs >= session.expiresAt
    });
  }

  async applyAuthResponse(response, generation) {
    if (generation !== this.generation) {
      throw new AuthStoreError("A sessão mudou durante a autenticação.", "SESSION_CHANGED");
    }
    const session = normalizeSession({
      accessToken: response?.accessToken,
      refreshToken: response?.refreshToken,
      user: response?.user,
      expiresAt: resolveExpiresAt(response, this.now())
    });
    await this.store.save(session);
    if (generation !== this.generation) {
      throw new AuthStoreError("A sessão mudou durante a autenticação.", "SESSION_CHANGED");
    }
    this.session = session;
    this.preferredEmail = safeUser(session.user)?.email || this.preferredEmail;
    return session;
  }

  async login(email, password) {
    const generation = ++this.generation;
    this.session = null;
    const response = await this.apiClient.login(email, password);
    await this.applyAuthResponse(response, generation);
    return this.getStatus();
  }

  async restore() {
    const generation = ++this.generation;
    this.session = null;
    const restored = await this.store.load();
    if (generation !== this.generation) return this.getStatus();
    this.session = restored;
    if (!restored) return this.getStatus();
    this.preferredEmail = safeUser(restored.user)?.email || this.preferredEmail;
    await this.getAccessToken();
    return this.getStatus();
  }

  initialize() {
    return this.restore();
  }

  // Somente o processo principal deve chamar este método. Nunca o exponha pelo preload.
  async getAccessToken() {
    if (!this.session) {
      throw new AuthStoreError("Nenhuma sessão autenticada está disponível.", "NOT_AUTHENTICATED");
    }
    if (this.now() + this.refreshMarginMs < this.session.expiresAt) {
      return this.session.accessToken;
    }

    if (!this.refreshPromise) {
      const generation = this.generation;
      const refreshToken = this.session.refreshToken;
      this.refreshPromise = (async () => {
        try {
          const response = await this.apiClient.refresh(refreshToken);
          return await this.applyAuthResponse(response, generation);
        } catch (error) {
          if (generation === this.generation && isDefinitiveRefreshFailure(error)) {
            this.generation += 1;
            this.session = null;
            await this.store.clear();
          }
          throw error;
        }
      })().finally(() => {
        this.refreshPromise = null;
      });
    }

    const refreshed = await this.refreshPromise;
    return refreshed.accessToken;
  }

  async withAccessToken(operation) {
    if (typeof operation !== "function") {
      throw new AuthStoreError("A operação autenticada é inválida.", "INVALID_OPERATION");
    }
    const accessToken = await this.getAccessToken();
    return operation(accessToken);
  }

  async logout() {
    const session = this.session;
    this.generation += 1;
    this.session = null;
    try {
      if (session?.accessToken) await this.apiClient.signout(session.accessToken);
    } catch {
      // A sessão local deve ser removida mesmo quando o gateway estiver indisponível.
    } finally {
      await this.store.clear();
    }
    return this.getStatus();
  }

  async clear() {
    this.generation += 1;
    this.session = null;
    await this.store.clear();
    return this.getStatus();
  }
}

export const AUTH_STORE_FILENAME = STORE_FILENAME;

export const __testing = {
  isDefinitiveRefreshFailure,
  jwtExpiresAt,
  normalizeSession,
  resolveExpiresAt,
  safeUser
};
