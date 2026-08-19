const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const HTTP_MESSAGES = Object.freeze({
  400: "O gateway recusou os dados enviados.",
  401: "A autenticação no gateway falhou.",
  403: "O gateway não autorizou esta operação.",
  404: "O recurso solicitado não foi encontrado.",
  409: "O gateway encontrou um conflito ao processar a solicitação.",
  429: "Muitas solicitações foram enviadas. Aguarde e tente novamente.",
  500: "O gateway encontrou um erro interno.",
  502: "O gateway recebeu uma resposta inválida do serviço de origem.",
  503: "O serviço está temporariamente indisponível.",
  504: "O gateway demorou demais para responder."
});

export class HodProApiError extends Error {
  constructor(message, code = "HODPRO_API_ERROR", status = null) {
    super(message);
    this.name = "HodProApiError";
    this.code = code;
    this.status = status;
  }
}

function requiredString(value, label, { trim = true } = {}) {
  if (typeof value !== "string") {
    throw new HodProApiError(label + " não foi informado.", "INVALID_ARGUMENT");
  }
  const normalized = trim ? value.trim() : value;
  if (!normalized) {
    throw new HodProApiError(label + " não foi informado.", "INVALID_ARGUMENT");
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new HodProApiError("A URL do gateway é inválida.", "INVALID_BASE_URL");
  }

  if (url.protocol !== "https:") {
    throw new HodProApiError(
      "A URL do gateway precisa usar HTTPS.",
      "INSECURE_BASE_URL"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HodProApiError(
      "A URL do gateway não pode conter credenciais, consulta ou fragmento.",
      "INVALID_BASE_URL"
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/api")) {
    throw new HodProApiError(
      "A URL base do gateway precisa terminar em /api.",
      "INVALID_BASE_URL"
    );
  }
  return url.href.replace(/\/$/, "");
}

function normalizeAuthResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HodProApiError(
      "O gateway retornou uma sessão inválida.",
      "INVALID_AUTH_RESPONSE"
    );
  }

  let accessToken;
  let refreshToken;
  try {
    accessToken = requiredString(value.access_token, "Token de acesso", { trim: false });
    refreshToken = requiredString(value.refresh_token, "Token de renovação", {
      trim: false
    });
  } catch {
    throw new HodProApiError(
      "O gateway retornou uma sessão inválida.",
      "INVALID_AUTH_RESPONSE"
    );
  }
  if (!value.user || typeof value.user !== "object" || Array.isArray(value.user)) {
    throw new HodProApiError(
      "O gateway retornou um usuário inválido.",
      "INVALID_AUTH_RESPONSE"
    );
  }

  const expiresIn = Number(value.expires_in);
  return Object.freeze({
    accessToken,
    refreshToken,
    user: value.user,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null
  });
}

function normalizeLogoutReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new HodProApiError("Os dados do reporte não foram informados.", "INVALID_ARGUMENT");
  }
  return {
    user_id: requiredString(report.userId ?? report.user_id, "Usuário"),
    user_email: requiredString(report.userEmail ?? report.user_email, "E-mail do usuário"),
    user_name: requiredString(report.userName ?? report.user_name, "Nome do usuário"),
    tool_id: requiredString(report.toolId ?? report.tool_id, "Ferramenta"),
    tool_name: requiredString(report.toolName ?? report.tool_name, "Nome da ferramenta"),
    confirmation_word: requiredString(
      report.confirmationWord ?? report.confirmation_word,
      "Palavra de confirmação"
    )
  };
}

function httpMessage(status) {
  return HTTP_MESSAGES[status] || "A solicitação ao gateway falhou (HTTP " + status + ").";
}

async function readResponseBody(response, maximumBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel?.().catch?.(() => undefined);
    throw new HodProApiError(
      "A resposta do gateway excedeu o limite permitido.",
      "RESPONSE_TOO_LARGE",
      response.status
    );
  }

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new HodProApiError(
        "A resposta do gateway excedeu o limite permitido.",
        "RESPONSE_TOO_LARGE",
        response.status
      );
    }
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HodProApiError(
          "A resposta do gateway excedeu o limite permitido.",
          "RESPONSE_TOO_LARGE",
          response.status
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export class HodProApi {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    AbortControllerImpl = globalThis.AbortController,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new HodProApiError("Nenhum cliente HTTP foi configurado.", "INVALID_FETCH");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new HodProApiError("O tempo limite do gateway é inválido.", "INVALID_TIMEOUT");
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw new HodProApiError(
        "O limite de resposta do gateway é inválido.",
        "INVALID_RESPONSE_LIMIT"
      );
    }

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.AbortController = AbortControllerImpl;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
  }

  async request(endpoint, { body = {}, accessToken = null, hwid = null } = {}) {
    const controller = new this.AbortController();
    const timeoutId = this.setTimeout(() => controller.abort(), this.timeoutMs);

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    if (accessToken !== null) {
      headers.Authorization = "Bearer " + requiredString(accessToken, "Token de acesso", {
        trim: false
      });
    }
    if (hwid !== null) {
      headers["X-HWID"] = requiredString(hwid, "Identificador do dispositivo");
    }

    let response;
    let responseText;
    try {
      response = await this.fetch(this.baseUrl + endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store"
      });
      responseText = await readResponseBody(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof HodProApiError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new HodProApiError(
          "O gateway demorou demais para responder.",
          "GATEWAY_TIMEOUT"
        );
      }
      throw new HodProApiError(
        "Não foi possível conectar ao gateway.",
        "GATEWAY_NETWORK"
      );
    } finally {
      this.clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new HodProApiError(
        httpMessage(response.status),
        "GATEWAY_HTTP_" + response.status,
        response.status
      );
    }

    if (!responseText) return {};
    try {
      return JSON.parse(responseText);
    } catch {
      throw new HodProApiError(
        "O gateway retornou uma resposta inválida.",
        "INVALID_RESPONSE",
        response.status
      );
    }
  }

  async login(email, password) {
    const data = await this.request("/auth/login", {
      body: {
        email: requiredString(email, "E-mail"),
        password: requiredString(password, "Senha", { trim: false })
      }
    });
    return normalizeAuthResponse(data);
  }

  async refresh(refreshToken) {
    const data = await this.request("/auth/refresh", {
      body: {
        refresh_token: requiredString(refreshToken, "Token de renovação", { trim: false })
      }
    });
    return normalizeAuthResponse(data);
  }

  getUser(accessToken) {
    return this.request("/auth/user", { accessToken });
  }

  signout(accessToken) {
    return this.request("/auth/signout", { accessToken });
  }

  verifyDevice(userId, hwid, accessToken = null) {
    return this.request("/data/verify", {
      body: {
        user_id: requiredString(userId, "Usuário"),
        hwid: requiredString(hwid, "Identificador do dispositivo")
      },
      hwid,
      accessToken
    });
  }

  listTools(accessToken = null) {
    return this.request("/data/tools", { accessToken });
  }

  poll(userId, accessToken = null) {
    return this.request("/data/poll", {
      body: { user_id: requiredString(userId, "Usuário") },
      accessToken
    });
  }

  reportLogout(report, accessToken = null) {
    return this.request("/data/report-logout", {
      body: normalizeLogoutReport(report),
      accessToken
    });
  }

  allocate(toolId, userEmail, accessToken = null) {
    return this.request("/tools/allocate", {
      body: {
        tool_id: requiredString(toolId, "Ferramenta"),
        user_email: requiredString(userEmail, "E-mail do usuário")
      },
      accessToken
    });
  }

  getAccountDetails(accountId, accessToken = null) {
    return this.request("/tools/details", {
      body: { account_id: requiredString(accountId, "Conta") },
      accessToken
    });
  }

  getAccountSession(accountId, hwid, accessToken) {
    const normalizedHwid = requiredString(hwid, "Identificador do dispositivo");
    return this.request("/tools/session", {
      body: {
        account_id: requiredString(accountId, "Conta"),
        hwid: normalizedHwid
      },
      hwid: normalizedHwid,
      accessToken
    });
  }
}

export function createHodProApiClient(options) {
  return new HodProApi(options);
}

export const HodProApiClient = HodProApi;

export const __testing = {
  normalizeAuthResponse,
  normalizeBaseUrl,
  normalizeLogoutReport,
  readResponseBody
};
