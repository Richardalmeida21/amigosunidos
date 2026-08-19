import crypto from "node:crypto";
import { parseJsonish } from "./session-data.mjs";
import { SafeAppError } from "./supabase.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRMATION_PATTERN = /^[A-Z2-9]{4}$/;
const MAX_ENCRYPTED_SESSION_BYTES = 64 * 1024 * 1024;

function ensureUuid(value, code = "INVALID_TOOL_ID") {
  const normalized = String(value ?? "");
  if (!UUID_PATTERN.test(normalized)) {
    throw new SafeAppError("Identificador inválido.", code);
  }
  return normalized;
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeText(value, fallback, maximum = 160) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text.slice(0, maximum);
}

function parseContainer(value, fallback) {
  try {
    return parseJsonish(value, { fallback });
  } catch {
    return fallback;
  }
}

function objectPayload(value) {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] : {};
  if (!value || typeof value !== "object") return {};
  return value.account ?? value.details ?? value.data ?? value;
}

function legacyStorageFromCookies(cookiesValue) {
  const parsed = parseContainer(cookiesValue, []);
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const merged = {};
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.name && (item.domain || item.url)) continue;
    Object.assign(merged, item);
  }
  return merged;
}

function mergeStorageValue(primary, fallback) {
  const first = parseContainer(fallback, {});
  const second = parseContainer(primary, {});
  return {
    ...(first && typeof first === "object" && !Array.isArray(first) ? first : {}),
    ...(second && typeof second === "object" && !Array.isArray(second) ? second : {})
  };
}

function base64Buffer(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCRYPTED_SESSION_BYTES * 2) {
    throw new SafeAppError("O pacote de sessão criptografado é inválido.", label);
  }
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new SafeAppError("O pacote de sessão criptografado é inválido.", label);
  }
  const buffer = Buffer.from(compact, "base64");
  if (buffer.length === 0 || buffer.length > MAX_ENCRYPTED_SESSION_BYTES) {
    throw new SafeAppError("O pacote de sessão criptografado é inválido.", label);
  }
  return buffer;
}

export function decryptSessionBundle(record, accessToken) {
  const envelope = parseContainer(record?.encrypted_session, null);
  if (!envelope) return record;
  if (!accessToken || typeof envelope !== "object") {
    throw new SafeAppError("Não foi possível abrir o pacote de sessão.", "SESSION_DECRYPTION_FAILED");
  }

  try {
    const encrypted = base64Buffer(envelope.encrypted, "SESSION_DECRYPTION_FAILED");
    const iv = base64Buffer(envelope.iv, "SESSION_DECRYPTION_FAILED");
    if (encrypted.length <= 16 || iv.length < 8 || iv.length > 32) throw new Error("invalid");
    const key = crypto.createHash("sha256").update(accessToken).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const clear = Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - 16)),
      decipher.final()
    ]).toString("utf8");
    const decoded = JSON.parse(clear);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid");
    const merged = { ...record, ...decoded };
    delete merged.encrypted_session;
    return merged;
  } catch (error) {
    if (error instanceof SafeAppError) throw error;
    throw new SafeAppError("Não foi possível abrir o pacote de sessão.", "SESSION_DECRYPTION_FAILED");
  }
}

function toolArray(payload) {
  const tools = Array.isArray(payload) ? payload : payload?.tools;
  if (!Array.isArray(tools)) {
    throw new SafeAppError("O servidor retornou uma lista de ferramentas inválida.", "INVALID_TOOLS_RESPONSE");
  }
  return tools;
}

function normalizeTool(row) {
  const id = ensureUuid(row?.id);
  const baseUrl = safeUrl(row?.base_url ?? row?.baseUrl);
  const loginUrl = safeUrl(row?.login_url ?? row?.loginUrl);
  const launchUrl = baseUrl || loginUrl;
  const isActive = row?.is_active === true || row?.isActive === true;
  const isHidden = row?.is_hidden === true || row?.isHidden === true;
  const inMaintenance = row?.is_in_maintenance === true || row?.inMaintenance === true;
  return {
    id,
    name: safeText(row?.name, "Ferramenta"),
    category: safeText(row?.category, null, 80),
    hostname: launchUrl ? new URL(launchUrl).hostname : null,
    iconUrl: safeUrl(row?.icon_url ?? row?.image_url),
    baseUrl,
    loginUrl,
    loginScript: typeof row?.login_script === "string" && row.login_script.length <= 250_000
      ? row.login_script
      : null,
    checkSelector: safeText(row?.check_selector ?? row?.checkSelector, null, 2_000),
    isActive,
    isHidden,
    inMaintenance,
    canOpen: Boolean(launchUrl && isActive && !isHidden && !inMaintenance)
  };
}

function publicTool(tool) {
  return {
    id: tool.id,
    name: tool.name,
    category: tool.category,
    hostname: tool.hostname,
    iconUrl: tool.iconUrl,
    isActive: tool.isActive,
    inMaintenance: tool.inMaintenance,
    canOpen: tool.canOpen
  };
}

function cookieOrigins(cookiesValue) {
  const parsed = parseContainer(cookiesValue, []);
  const cookies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const origins = [];
  for (const cookie of cookies) {
    if (typeof cookie?.url === "string") {
      const parsedUrl = safeUrl(cookie.url);
      if (parsedUrl) {
        const origin = new URL(parsedUrl).origin;
        if (!origins.includes(origin)) origins.push(origin);
      }
    }
    const rawDomain = typeof cookie?.domain === "string" ? cookie.domain.replace(/^\./, "").trim() : "";
    if (!rawDomain || rawDomain.includes("/") || rawDomain.includes(":")) continue;
    try {
      const origin = new URL("https://" + rawDomain).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      // Um domínio inválido não amplia a allowlist.
    }
  }
  return origins;
}

function normalizeCredentials(value) {
  const credentials = parseContainer(value, null);
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return null;
  const email = typeof credentials.email === "string" ? credentials.email : "";
  const username = typeof credentials.username === "string" ? credentials.username : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";
  if (!email && !username && !password) return null;
  return { email, username, password };
}

function normalizeOrigins(session, targetOrigin) {
  const structured = parseContainer(session.origins ?? session.storage_by_origin, null);
  if (Array.isArray(structured)) return structured;
  if (structured && typeof structured === "object") {
    return Object.entries(structured).map(([origin, value]) => ({ origin, ...(value || {}) }));
  }
  return [{
    origin: targetOrigin,
    localStorage: session.local_storage,
    sessionStorage: session.session_storage,
    indexedDB: session.indexed_db
  }];
}

function maintenanceIds(payload) {
  const raw = payload?.maintenance_tools ?? payload?.maintenanceIds ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => typeof item === "string" ? item : item?.tool_id ?? item?.id)
    .filter((id) => UUID_PATTERN.test(String(id)))
    .map(String);
}

function visibleToolIds(payload) {
  const raw = payload?.visible_tool_ids ?? payload?.visibleToolIds;
  if (!Array.isArray(raw)) {
    throw new SafeAppError(
      "O serviço não retornou as permissões de ferramentas.",
      "INVALID_POLL_RESPONSE"
    );
  }
  return raw
    .map((item) => typeof item === "string" ? item : item?.tool_id ?? item?.id)
    .filter((id) => UUID_PATTERN.test(String(id)))
    .map(String);
}

function accessState(payload, now) {
  const profile = payload?.profile && typeof payload.profile === "object"
    ? payload.profile
    : {};
  const config = payload?.config && typeof payload.config === "object"
    ? payload.config
    : {};
  if (config.maintenance_mode === true) {
    return { blocked: true, code: "SERVICE_MAINTENANCE" };
  }
  if (profile.is_blocked === true) {
    return { blocked: true, code: "PROFILE_BLOCKED" };
  }
  const expiration = profile.subscription_end ?? profile.subscriptionEnd ?? profile.subscription_end_date;
  if (expiration) {
    const expiresAt = Date.parse(expiration);
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      return { blocked: true, code: "SUBSCRIPTION_EXPIRED" };
    }
  }
  return { blocked: false, code: null };
}

function verificationDenied(payload) {
  const status = String(payload?.status ?? "").trim().toLowerCase();
  return payload === false || payload?.verified === false || payload?.is_verified === false ||
    payload?.allowed === false || payload?.authorized === false || payload?.success === false ||
    ["maintenance", "blocked", "expired"].includes(status);
}

export class HodProService {
  constructor({ api, auth, browserManager, deviceId, now = () => Date.now() }) {
    this.api = api;
    this.auth = auth;
    this.browserManager = browserManager;
    this.deviceId = deviceId;
    this.now = now;
    this.tools = new Map();
    this.openAccounts = new Map();
    this.replaceOnNextOpen = new Set();
    this.toolOperations = new Map();
    this.acceptingOperations = true;
    this.currentAccessState = { blocked: false, code: null };
  }

  async initialize() {
    try {
      await this.auth.initialize();
    } catch (error) {
      if (["CORRUPT_SESSION", "INVALID_SESSION"].includes(error?.code)) {
        await this.auth.clear().catch(() => undefined);
      } else if (["ENCRYPTION_UNAVAILABLE", "READ_FAILED"].includes(error?.code)) {
        throw error;
      }
      // Uma falha transitória de rede não apaga um refresh token ainda utilizável.
    }
    const status = await this.auth.getStatus();
    if (status.authenticated) {
      try {
        await this.verifyCurrentDevice();
      } catch (error) {
        if (["DEVICE_NOT_AUTHORIZED", "GATEWAY_HTTP_401", "GATEWAY_HTTP_403"].includes(error?.code)) {
          await this.auth.clear();
        }
      }
    }
    return this.auth.getStatus();
  }

  getAuthStatus() {
    return this.auth.getStatus();
  }

  async login(email, password) {
    if (typeof email !== "string" || email.trim().length > 320 || !email.includes("@")) {
      throw new SafeAppError("Informe um e-mail válido.", "INVALID_EMAIL");
    }
    if (typeof password !== "string" || password.length === 0 || password.length > 4096) {
      throw new SafeAppError("Informe a senha.", "INVALID_PASSWORD");
    }
    await this.auth.login(email.trim(), password);
    try {
      await this.verifyCurrentDevice();
    } catch (error) {
      await this.auth.logout().catch(() => this.auth.clear());
      throw error;
    }
    return this.auth.getStatus();
  }

  async logout() {
    this.acceptingOperations = false;
    await Promise.allSettled([...this.toolOperations.values()]);
    await this.browserManager.close();
    this.openAccounts.clear();
    this.replaceOnNextOpen.clear();
    this.tools.clear();
    try {
      await this.auth.logout();
      return this.auth.getStatus();
    } finally {
      this.acceptingOperations = true;
    }
  }

  async withToken(operation) {
    try {
      return await this.auth.withAccessToken(operation);
    } catch (error) {
      if ([401, 403].includes(error?.status) || ["GATEWAY_HTTP_401", "GATEWAY_HTTP_403"].includes(error?.code)) {
        await this.browserManager.close().catch(() => undefined);
        this.openAccounts.clear();
        await this.auth.clear().catch(() => undefined);
      }
      throw error;
    }
  }

  enqueueToolOperation(toolId, operation) {
    if (!this.acceptingOperations) {
      throw new SafeAppError("A sessão está sendo encerrada.", "SESSION_CLOSING");
    }
    const previous = this.toolOperations.get(toolId) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.toolOperations.set(toolId, pending);
    return pending.finally(() => {
      if (this.toolOperations.get(toolId) === pending) this.toolOperations.delete(toolId);
    });
  }

  async verifyCurrentDevice() {
    const status = await this.auth.getStatus();
    const userId = ensureUuid(status?.user?.id, "INVALID_USER_ID");
    const response = await this.withToken((token) =>
      this.api.verifyDevice(userId, this.deviceId, token)
    );
    if (verificationDenied(response)) {
      throw new SafeAppError(
        "Este dispositivo não foi autorizado pelo serviço.",
        "DEVICE_NOT_AUTHORIZED"
      );
    }
    return true;
  }

  async listTools() {
    const status = await this.auth.getStatus();
    const userId = ensureUuid(status?.user?.id, "INVALID_USER_ID");
    const { toolsPayload, pollPayload } = await this.withToken(async (token) => {
      const [toolsPayload, pollPayload] = await Promise.all([
        this.api.listTools(token),
        this.api.poll(userId, token)
      ]);
      return { toolsPayload, pollPayload };
    });
    if (
      !pollPayload || typeof pollPayload !== "object" ||
      (!Object.hasOwn(pollPayload, "maintenance_tools") && !Object.hasOwn(pollPayload, "maintenanceIds"))
    ) {
      throw new SafeAppError("O serviço retornou permissões inválidas.", "INVALID_POLL_RESPONSE");
    }
    const visible = new Set(visibleToolIds(pollPayload));
    const maintenance = new Set(maintenanceIds(pollPayload));
    this.currentAccessState = accessState(pollPayload, this.now());
    const normalized = toolArray(toolsPayload)
      .map(normalizeTool)
      .filter((tool) => visible.has(tool.id));
    for (const tool of normalized) {
      tool.inMaintenance = tool.inMaintenance || maintenance.has(tool.id);
      tool.canOpen = Boolean(
        (tool.baseUrl || tool.loginUrl) && tool.isActive && !tool.isHidden &&
        !tool.inMaintenance && !this.currentAccessState.blocked
      );
    }
    this.tools = new Map(normalized.map((tool) => [tool.id, tool]));
    return {
      tools: normalized.filter((tool) => !tool.isHidden).map(publicTool),
      maintenanceIds: normalized.filter((tool) => tool.inMaintenance).map((tool) => tool.id),
      access: { ...this.currentAccessState }
    };
  }

  async requireTool(toolId, { fresh = false } = {}) {
    const id = ensureUuid(toolId);
    if (fresh || !this.tools.has(id)) await this.listTools();
    if (this.currentAccessState.blocked) {
      throw new SafeAppError("Seu acesso está temporariamente indisponível.", this.currentAccessState.code);
    }
    const tool = this.tools.get(id);
    if (!tool || tool.isHidden) throw new SafeAppError("Ferramenta não encontrada.", "TOOL_NOT_FOUND");
    if (!tool.isActive) throw new SafeAppError("Essa ferramenta está inativa.", "TOOL_INACTIVE");
    if (tool.inMaintenance) throw new SafeAppError("Essa ferramenta está em manutenção.", "TOOL_MAINTENANCE");
    if (!tool.baseUrl && !tool.loginUrl) throw new SafeAppError("Essa ferramenta não possui URL segura.", "MISSING_LAUNCH_URL");
    return tool;
  }

  async loadCurrentSession(tool) {
    const authStatus = await this.auth.getStatus();
    const userEmail = authStatus?.user?.email;
    if (!userEmail) throw new SafeAppError("Faça login novamente.", "AUTH_REQUIRED");

    return this.withToken(async (token) => {
      const allocation = await this.api.allocate(tool.id, userEmail, token);
      const account = allocation?.account ?? allocation;
      const accountId = ensureUuid(account?.id, "INVALID_ACCOUNT_ID");
      if (account?.tool_id && String(account.tool_id) !== tool.id) {
        throw new SafeAppError("O servidor retornou uma conta incompatível.", "ACCOUNT_TOOL_MISMATCH");
      }
      const [rawSession, rawDetails] = await Promise.all([
        this.api.getAccountSession(accountId, this.deviceId, token),
        this.api.getAccountDetails(accountId, token)
      ]);
      const details = objectPayload(rawDetails);
      const session = {
        ...details,
        ...decryptSessionBundle(rawSession?.session ?? rawSession?.account ?? rawSession, token)
      };
      if (!session || typeof session !== "object") {
        throw new SafeAppError("O servidor não retornou uma sessão válida.", "INVALID_SESSION_RESPONSE");
      }
      const detailedTool = objectPayload(details.tool ?? details.tools ?? {});
      const effectiveTool = {
        ...tool,
        baseUrl: safeUrl(detailedTool.base_url ?? details.base_url) || tool.baseUrl,
        loginUrl: safeUrl(detailedTool.login_url ?? details.login_url) || tool.loginUrl,
        loginScript:
          (typeof detailedTool.login_script === "string" ? detailedTool.login_script : null) ??
          (typeof details.login_script === "string" ? details.login_script : null) ??
          tool.loginScript,
        checkSelector:
          safeText(detailedTool.check_selector ?? details.check_selector, null, 2_000) ??
          tool.checkSelector
      };
      const targetUrl = safeUrl(effectiveTool.baseUrl || effectiveTool.loginUrl);
      const targetOrigin = new URL(targetUrl).origin;
      const origins = normalizeOrigins(session, targetOrigin);
      const storageOrigins = origins
        .map((entry) => safeUrl(entry?.origin))
        .filter(Boolean)
        .map((value) => new URL(value).origin);
      const allowedOrigins = [...new Set([
        new URL(targetUrl).origin,
        ...(effectiveTool.baseUrl ? [new URL(effectiveTool.baseUrl).origin] : []),
        ...(effectiveTool.loginUrl ? [new URL(effectiveTool.loginUrl).origin] : []),
        ...cookieOrigins(session.cookies_json ?? session.cookies),
        ...storageOrigins
      ])];
      return {
        id: accountId,
        accountName: safeText(account?.account_name ?? session.account_name, "Conta alocada"),
        isActive: account?.is_active !== false && session.is_active !== false,
        updatedAt: session.updated_at ?? account?.updated_at ?? null,
        cookies: session.cookies_json ?? session.cookies,
        localStorage: mergeStorageValue(
          session.local_storage,
          legacyStorageFromCookies(session.cookies_json ?? session.cookies)
        ),
        sessionStorage: session.session_storage,
        indexedDb: session.indexed_db,
        origins,
        proxyUrl: session.proxy_url ?? detailedTool.proxy_server ?? details.proxy_server ?? null,
        userAgent: session.user_agent ?? null,
        credentials: normalizeCredentials(session.credentials_json ?? session.credentials),
        loginArgs: normalizeCredentials(session.credentials_json ?? session.credentials),
        trustedLoginScript: Boolean(effectiveTool.loginScript),
        persistentProfile: true,
        profileKey: tool.id + ":" + accountId,
        snapshotPolicy: "fill-missing",
        allowedOrigins,
        tool: {
          id: effectiveTool.id,
          name: effectiveTool.name,
          baseUrl: effectiveTool.baseUrl,
          loginUrl: effectiveTool.loginUrl,
          loginScript: effectiveTool.loginScript,
          checkSelector: effectiveTool.checkSelector,
          hasLaunchUrl: true
        }
      };
    });
  }

  async openTool(toolId) {
    const id = ensureUuid(toolId);
    return this.enqueueToolOperation(id, () => this.openToolOnce(id));
  }

  async openToolOnce(toolId) {
    const tool = await this.requireTool(toolId, { fresh: true });
    const account = await this.loadCurrentSession(tool);
    if (!account.isActive) throw new SafeAppError("A conta alocada está inativa.", "ACCOUNT_INACTIVE");
    const previousAccountId = this.openAccounts.get(tool.id);
    if (previousAccountId && previousAccountId !== account.id) {
      await this.browserManager.closeAccountContext(previousAccountId);
    }
    const replaceSnapshot = this.replaceOnNextOpen.has(tool.id);
    if (replaceSnapshot) account.snapshotPolicy = "replace";
    const result = await this.browserManager.openAccount(account);
    if (replaceSnapshot) this.replaceOnNextOpen.delete(tool.id);
    this.openAccounts.set(tool.id, account.id);
    return { ...result, sessionUpdatedAt: result.reused ? null : account.updatedAt };
  }

  async restartTool(toolId) {
    const id = ensureUuid(toolId);
    return this.enqueueToolOperation(id, () => this.restartToolOnce(id));
  }

  async restartToolOnce(toolId) {
    const tool = await this.requireTool(toolId, { fresh: true });
    const previousAccountId = this.openAccounts.get(tool.id);
    if (previousAccountId) await this.browserManager.closeAccountContext(previousAccountId);
    const account = await this.loadCurrentSession(tool);
    account.snapshotPolicy = "replace";
    const result = await this.browserManager.openAccount(account);
    this.openAccounts.set(tool.id, account.id);
    return { ...result, restarted: true, sessionUpdatedAt: account.updatedAt };
  }

  async reportTool(toolId, confirmationWord) {
    const id = ensureUuid(toolId);
    return this.enqueueToolOperation(id, () => this.reportToolOnce(id, confirmationWord));
  }

  async reportToolOnce(toolId, confirmationWord) {
    const tool = await this.requireTool(toolId);
    const confirmation = String(confirmationWord ?? "").trim().toUpperCase();
    if (!CONFIRMATION_PATTERN.test(confirmation)) {
      throw new SafeAppError("A confirmação do reporte é inválida.", "INVALID_CONFIRMATION");
    }
    const status = await this.auth.getStatus();
    const user = status?.user;
    if (!user?.id || !user?.email) throw new SafeAppError("Faça login novamente.", "AUTH_REQUIRED");
    const reportResult = await this.withToken((token) => this.api.reportLogout({
      user_id: user.id,
      user_email: user.email,
      user_name: user.name || user.fullName || user.email,
      tool_id: tool.id,
      tool_name: tool.name,
      confirmation_word: confirmation
    }, token));
    if (reportResult?.success !== true) {
      throw new SafeAppError(
        "O serviço não confirmou o reporte.",
        "REPORT_NOT_CONFIRMED"
      );
    }
    const accountId = this.openAccounts.get(tool.id);
    if (accountId) await this.browserManager.closeAccountContext(accountId);
    this.openAccounts.delete(tool.id);
    this.replaceOnNextOpen.add(tool.id);
    return { success: true, maintenance: true, cooldownUntil: this.now() + 10 * 60_000 };
  }

  async pollTools() {
    const status = await this.auth.getStatus();
    const userId = ensureUuid(status?.user?.id, "INVALID_USER_ID");
    const payload = await this.withToken((token) => this.api.poll(userId, token));
    if (
      !payload || typeof payload !== "object" ||
      (!Object.hasOwn(payload, "maintenance_tools") && !Object.hasOwn(payload, "maintenanceIds"))
    ) {
      throw new SafeAppError(
        "O serviço retornou um estado de manutenção inválido.",
        "INVALID_POLL_RESPONSE"
      );
    }
    const ids = maintenanceIds(payload);
    const visible = new Set(visibleToolIds(payload));
    this.currentAccessState = accessState(payload, this.now());
    for (const [id, tool] of this.tools) {
      tool.inMaintenance = ids.includes(id);
      tool.canOpen = Boolean(
        visible.has(id) && (tool.baseUrl || tool.loginUrl) && tool.isActive &&
        !tool.isHidden && !tool.inMaintenance && !this.currentAccessState.blocked
      );
    }
    const cachedIds = new Set(this.tools.keys());
    const visibleChanged = visible.size !== cachedIds.size ||
      [...visible].some((id) => !cachedIds.has(id));
    return {
      maintenanceIds: ids,
      toolsChanged: payload?.tools_changed === true || visibleChanged,
      access: { ...this.currentAccessState }
    };
  }
}

export const __testing = {
  cookieOrigins,
  maintenanceIds,
  visibleToolIds,
  accessState,
  normalizeTool,
  verificationDenied
};
