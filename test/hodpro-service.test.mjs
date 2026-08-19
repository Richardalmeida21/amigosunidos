import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptSessionBundle, HodProService, __testing } from "../src/hodpro-service.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

function tool(overrides = {}) {
  return {
    id: TOOL_ID,
    name: "Ferramenta de laboratório",
    category: "Teste",
    base_url: "https://app.example.test/dashboard",
    login_url: "https://app.example.test/login",
    is_active: true,
    is_hidden: false,
    is_in_maintenance: false,
    login_script: "document.body.dataset.login = email + password.length",
    ...overrides
  };
}

function harness({ initialPoll = {}, appVersion = "1.0.0" } = {}) {
  const calls = [];
  let pollPayload = {
    maintenance_tools: [],
    visible_tool_ids: [TOOL_ID],
    ...initialPoll
  };
  const api = {
    async verifyDevice(userId, hwid, token) {
      calls.push(["verify", userId, hwid, token]);
      return { verified: true };
    },
    async listTools(token) {
      calls.push(["list", token]);
      return [tool()];
    },
    async allocate(toolId, email, token) {
      calls.push(["allocate", toolId, email, token]);
      return { allocated: true, account: { id: ACCOUNT_ID, tool_id: TOOL_ID, is_active: true } };
    },
    async getAccountSession(accountId, hwid, token) {
      calls.push(["session", accountId, hwid, token]);
      return {
        cookies_json: [{ name: "lab", value: "valor-ficticio", domain: ".example.test", path: "/" }],
        local_storage: { theme: "dark" },
        credentials_json: { email: "conta@example.test", password: "senha-ficticia" },
        updated_at: "2026-08-19T20:00:00Z"
      };
    },
    async getAccountDetails(accountId, token) {
      calls.push(["details", accountId, token]);
      return {};
    },
    async reportLogout(report, token) {
      calls.push(["report", report, token]);
      return { success: true };
    },
    async poll(userId, token) {
      calls.push(["poll", userId, token]);
      return pollPayload;
    }
  };
  const auth = {
    async initialize() {},
    getStatus() {
      return {
        authenticated: true,
        user: { id: USER_ID, email: "usuario@example.test", fullName: "Usuário Teste" }
      };
    },
    async withAccessToken(operation) {
      return operation("access-token-ficticio");
    },
    async login() {},
    async logout() { return { authenticated: false, user: null }; },
    async clear() {}
  };
  const browserCalls = [];
  const browserManager = {
    async openAccount(account) {
      browserCalls.push(["open", account]);
      return { reused: false, cookiesApplied: 1, loginDetected: false };
    },
    async closeAccountContext(id) {
      browserCalls.push(["close", id]);
      return true;
    },
    async close() { browserCalls.push(["close-all"]); }
  };
  return {
    service: new HodProService({
      api,
      auth,
      browserManager,
      deviceId: "hwid-hash-ficticio",
      appVersion,
      now: () => 1_700_000_000_000
    }),
    calls,
    browserCalls,
    setPoll(next) {
      pollPayload = { ...pollPayload, ...next };
    }
  };
}

test("lista somente metadados seguros e respeita manutenção/visibilidade", async () => {
  const { service } = harness({ initialPoll: { maintenance_tools: [TOOL_ID] } });
  const result = await service.listTools();
  assert.equal(result.tools.length, 1);
  assert.deepEqual(Object.keys(result.tools[0]).sort(), [
    "canOpen", "category", "hostname", "iconUrl", "id", "inMaintenance", "isActive", "name"
  ]);
  assert.equal(result.tools[0].inMaintenance, true);
  assert.equal(result.tools[0].canOpen, false);
  assert.deepEqual(result.access, { blocked: false, code: null });
  assert.equal(JSON.stringify(result).includes("login_script"), false);
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("poll sem profile continua compatível e não bloqueia o painel", async () => {
  const { service, browserCalls } = harness();
  const result = await service.listTools();
  assert.deepEqual(result.access, { blocked: false, code: null });
  assert.equal(result.tools[0].canOpen, true);
  assert.equal(browserCalls.some((entry) => entry[0] === "close-all"), false);
});

test("profile explicitamente inválido bloqueia e revoga contextos sem lançar TypeError", async () => {
  const { service, browserCalls } = harness({ initialPoll: { profile: null } });
  const result = await service.listTools();
  assert.deepEqual(result.access, { blocked: true, code: "PROFILE_UNAVAILABLE" });
  assert.equal(result.tools[0].canOpen, false);
  assert.equal(browserCalls.some((entry) => entry[0] === "close-all"), true);
});

test("versão mínima usa a versão real configurada no serviço", async () => {
  const outdated = harness({
    appVersion: "1.0.0",
    initialPoll: { config: { min_required_version: "1.1.0" } }
  });
  const blocked = await outdated.service.listTools();
  assert.deepEqual(blocked.access, { blocked: true, code: "CLIENT_UPDATE_REQUIRED" });

  const current = harness({
    appVersion: "1.1.0",
    initialPoll: { config: { min_required_version: "1.1.0" } }
  });
  const allowed = await current.service.listTools();
  assert.deepEqual(allowed.access, { blocked: false, code: null });
});

test("abrir aloca e busca a sessão atual antes de entregar somente o resultado operacional", async () => {
  const { service, calls, browserCalls } = harness();
  const result = await service.openTool(TOOL_ID);
  assert.equal(result.loginDetected, false);
  assert.equal(JSON.stringify(result).includes("senha-ficticia"), false);
  assert.deepEqual(calls.map((entry) => entry[0]), ["list", "poll", "allocate", "session", "details"]);

  const account = browserCalls[0][1];
  assert.equal(account.persistentProfile, true);
  assert.equal(account.snapshotPolicy, "fill-missing");
  assert.equal(account.trustedLoginScript, true);
  assert.equal(account.credentials.password, "senha-ficticia");
  assert.ok(account.allowedOrigins.includes("https://example.test"));
});

test("reiniciar fecha o contexto anterior e substitui o snapshot com o pacote fresco", async () => {
  const { service, browserCalls } = harness();
  await service.openTool(TOOL_ID);
  await service.restartTool(TOOL_ID);
  assert.deepEqual(browserCalls.map((entry) => entry[0]), ["open", "close", "open"]);
  assert.equal(browserCalls.at(-1)[1].snapshotPolicy, "replace");
});

test("reporte exige confirmação, fecha o contexto e polling usa o usuário autenticado", async () => {
  const { service, calls, browserCalls, setPoll } = harness();
  await service.openTool(TOOL_ID);
  await assert.rejects(() => service.reportTool(TOOL_ID, "0000"), {
    code: "INVALID_CONFIRMATION"
  });
  const report = await service.reportTool(TOOL_ID, "AB2C");
  assert.deepEqual(report, {
    success: true,
    maintenance: true,
    cooldownUntil: 1_700_000_600_000
  });
  assert.ok(browserCalls.some((entry) => entry[0] === "close"));
  assert.ok(calls.some((entry) => entry[0] === "report"));

  setPoll({ maintenance_tools: [TOOL_ID] });
  assert.deepEqual(await service.pollTools(), {
    maintenanceIds: [TOOL_ID],
    toolsChanged: false,
    access: { blocked: false, code: null }
  });
});

test("comparação de versões considera os três componentes principais", () => {
  assert.equal(__testing.compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(__testing.compareVersions("1.2.4", "1.2.3") > 0);
  assert.ok(__testing.compareVersions("1.2.2", "1.2.3") < 0);
});

test("decryptSessionBundle abre somente envelope AES-GCM válido", () => {
  const token = "token-de-laboratorio";
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(token).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ local_storage: { chave: "valor" } })),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  const decoded = decryptSessionBundle({
    encrypted_session: {
      encrypted: ciphertext.toString("base64"),
      iv: iv.toString("base64")
    }
  }, token);
  assert.deepEqual(decoded.local_storage, { chave: "valor" });
  assert.equal("encrypted_session" in decoded, false);
  assert.throws(() => decryptSessionBundle({
    encrypted_session: { encrypted: ciphertext.toString("base64"), iv: iv.toString("base64") }
  }, "token-errado"), { code: "SESSION_DECRYPTION_FAILED" });
});
