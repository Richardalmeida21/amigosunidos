const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SafeAppError extends Error {
  constructor(message, code = "APP_ERROR") {
    super(message);
    this.name = "SafeAppError";
    this.code = code;
  }
}

function ensureUuid(value) {
  if (!UUID_PATTERN.test(String(value))) {
    throw new SafeAppError("Identificador de conta inválido.", "INVALID_ACCOUNT_ID");
  }
  return String(value);
}

function asTool(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value && typeof value === "object" ? value : null;
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (parsed.username || parsed.password) return null;
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    return parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && loopback)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function summarizeTool(value, { includeLaunchUrls = false } = {}) {
  const tool = asTool(value);
  if (!tool) return null;
  const baseUrl = safeUrl(tool.base_url);
  const loginUrl = safeUrl(tool.login_url);
  const launchUrl = baseUrl || loginUrl;
  const summary = {
    id: tool.id || null,
    name: tool.name || "Ferramenta",
    category: tool.category || null,
    hostname: launchUrl ? new URL(launchUrl).hostname : null,
    hasLaunchUrl: Boolean(launchUrl),
    isActive: tool.is_active === true,
    isHidden: tool.is_hidden === true,
    inMaintenance: tool.is_in_maintenance === true
  };
  if (includeLaunchUrls) {
    summary.baseUrl = baseUrl;
    summary.loginUrl = loginUrl;
  }
  return summary;
}

export function isAccountLaunchable(account) {
  return account?.isActive === true && account?.tool?.hasLaunchUrl === true;
}

function summarizeAccount(row, relation) {
  const account = {
    id: row.id,
    accountName: row.account_name || "Conta sem nome",
    loginMethod: row.login_method || "desconhecido",
    isActive: row.is_active === true,
    workerTag: row.worker_tag || null,
    updatedAt: row.updated_at || null,
    tool: summarizeTool(row[relation])
  };
  return { ...account, canOpen: isAccountLaunchable(account) };
}

export class SupabaseRepository {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async request(table, params) {
    const url = new URL(
      "/rest/v1/" + encodeURIComponent(table),
      this.config.supabaseUrl
    );
    for (const [key, value] of params.entries()) {
      url.searchParams.append(key, value);
    }

    const headers = {
      apikey: this.config.publishableKey,
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache"
    };
    if (this.config.accessToken) {
      headers.Authorization = "Bearer " + this.config.accessToken;
    }

    let response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw new SafeAppError("O Supabase demorou demais para responder.", "SUPABASE_TIMEOUT");
      }
      throw new SafeAppError("Não foi possível conectar ao Supabase.", "SUPABASE_NETWORK");
    }

    if (!response.ok) {
      throw new SafeAppError(
        "Consulta ao Supabase falhou (HTTP " + response.status + ").",
        "SUPABASE_HTTP_" + response.status
      );
    }

    try {
      return await response.json();
    } catch {
      throw new SafeAppError("O Supabase retornou uma resposta inválida.", "SUPABASE_INVALID_JSON");
    }
  }

  async listAccounts() {
    const relation = this.config.toolsRelation;
    const select = [
      "id",
      "tool_id",
      "account_name",
      "login_method",
      "is_active",
      "worker_tag",
      "updated_at",
      relation + "(id,name,base_url,login_url,category,is_active,is_hidden,is_in_maintenance)"
    ].join(",");

    const params = new URLSearchParams();
    params.set("select", select);
    params.set("order", "account_name.asc");
    params.set("limit", String(this.config.accountLimit));

    const rows = await this.request(this.config.accountsTable, params);
    if (!Array.isArray(rows)) {
      throw new SafeAppError("A lista de contas veio em formato inesperado.", "UNEXPECTED_ACCOUNTS");
    }
    return rows.map((row) => summarizeAccount(row, relation));
  }

  async getAccountSession(accountId) {
    const id = ensureUuid(accountId);
    const relation = this.config.toolsRelation;
    const select = [
      "id",
      "tool_id",
      "account_name",
      "login_method",
      "is_active",
      "updated_at",
      "cookies_json",
      "local_storage",
      "session_storage",
      "proxy_url",
      "user_agent",
      relation + "(id,name,base_url,login_url,is_active,is_hidden,is_in_maintenance)"
    ].join(",");

    const params = new URLSearchParams();
    params.set("select", select);
    params.set("id", "eq." + id);
    params.set("limit", "1");

    const rows = await this.request(this.config.accountsTable, params);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new SafeAppError("Conta não encontrada.", "ACCOUNT_NOT_FOUND");
    }

    const row = rows[0];
    const account = {
      id: row.id,
      accountName: row.account_name || "Conta sem nome",
      loginMethod: row.login_method || "desconhecido",
      isActive: row.is_active === true,
      updatedAt: row.updated_at || null,
      cookies: row.cookies_json,
      localStorage: row.local_storage,
      sessionStorage: row.session_storage,
      proxyUrl: row.proxy_url || null,
      userAgent: row.user_agent || null,
      tool: summarizeTool(row[relation], { includeLaunchUrls: true })
    };
    return { ...account, canOpen: isAccountLaunchable(account) };
  }
}

export const __testing = {
  ensureUuid,
  isAccountLaunchable,
  summarizeAccount,
  summarizeTool
};
