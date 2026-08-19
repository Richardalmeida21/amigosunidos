import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..");
const DEFAULT_GATEWAY_URL = "https://hodpro-api.patriksantos494.workers.dev/api";

function loadDotEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(PROJECT_DIR, ".env"),
    path.join(path.dirname(process.execPath), ".env")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, quiet: true });
      return candidate;
    }
  }
  return null;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "sim"].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(label + " contém um identificador inválido.");
  }
  return value;
}

function normalizeHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(label + " não contém uma URL válida.");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash
  ) {
    throw new Error(label + " precisa ser uma URL HTTPS sem credenciais, consulta ou fragmento.");
  }
  return url.href.replace(/\/$/, "");
}

function normalizeSupabaseUrl(value) {
  return new URL(normalizeHttpsUrl(value, "SUPABASE_URL")).origin;
}

function validateAccessToken(value) {
  const token = value?.trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("SUPABASE_ACCESS_TOKEN precisa ser um JWT de usuário.");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("SUPABASE_ACCESS_TOKEN não contém um JWT válido.");
  }
  if (["service_role", "supabase_admin", "anon"].includes(claims?.role)) {
    throw new Error("SUPABASE_ACCESS_TOKEN precisa pertencer a um usuário autenticado, nunca a um papel privilegiado ou anônimo.");
  }
  if (Number.isFinite(claims?.exp) && claims.exp <= Date.now() / 1000) {
    throw new Error("SUPABASE_ACCESS_TOKEN está expirado.");
  }
  return token;
}

function readExampleConnection() {
  const candidates = [path.join(process.cwd(), "Exemplo.txt"), path.join(PROJECT_DIR, "Exemplo.txt")];
  const examplePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!examplePath) return null;
  const content = fs.readFileSync(examplePath, "utf8");
  const urlMatch = content.match(/-Uri\s+["'](https:\/\/[a-z0-9-]+\.supabase\.co)\/rest\/v1\//i);
  const keyMatch = content.match(/apikey\s*=\s*["'](sb_publishable_[A-Za-z0-9_-]+)["']/i);
  if (!urlMatch || !keyMatch) return null;
  return { url: urlMatch[1], publishableKey: keyMatch[1], source: "Exemplo.txt" };
}

function loadLegacySupabaseConfig(envPath) {
  let url = process.env.SUPABASE_URL;
  let publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let source = envPath ? ".env" : "variáveis de ambiente";
  const allowFallback = parseBoolean(process.env.ALLOW_EXAMPLE_CONFIG_FALLBACK, false);
  if (Boolean(url) !== Boolean(publishableKey)) {
    throw new Error("Informe SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY juntos.");
  }
  if (!url && !publishableKey && allowFallback) {
    const fallback = readExampleConnection();
    if (fallback) {
      url = fallback.url;
      publishableKey = fallback.publishableKey;
      source = fallback.source;
    }
  }
  if (!url || !publishableKey) {
    throw new Error("O modo legacy_supabase exige SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY.");
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY não parece ser uma chave publicável válida.");
  }
  return {
    supabaseUrl: normalizeSupabaseUrl(url),
    publishableKey,
    accessToken: validateAccessToken(process.env.SUPABASE_ACCESS_TOKEN),
    accountsTable: assertIdentifier(process.env.SUPABASE_ACCOUNTS_TABLE || "tool_accounts", "SUPABASE_ACCOUNTS_TABLE"),
    toolsRelation: assertIdentifier(process.env.SUPABASE_TOOLS_RELATION || "tools", "SUPABASE_TOOLS_RELATION"),
    accountLimit: parsePositiveInteger(process.env.ACCOUNT_LIMIT, 500, 1000),
    configSource: source
  };
}

export function loadConfig() {
  const envPath = loadDotEnv();
  const dataMode = String(process.env.PANEL_DATA_MODE || "hodpro").trim().toLowerCase();
  if (!["hodpro", "legacy_supabase"].includes(dataMode)) {
    throw new Error("PANEL_DATA_MODE deve ser hodpro ou legacy_supabase.");
  }
  const browserChannel = String(process.env.BROWSER_CHANNEL || "chrome").trim().toLowerCase();
  if (!["chrome", "msedge", "chromium"].includes(browserChannel)) {
    throw new Error("BROWSER_CHANNEL deve ser chrome, msedge ou chromium.");
  }
  const common = {
    dataMode,
    browserChannel,
    projectDir: PROJECT_DIR,
    requestTimeoutMs: parsePositiveInteger(process.env.API_TIMEOUT_MS, 60_000, 120_000)
  };
  if (dataMode === "legacy_supabase") {
    return Object.freeze({ ...common, ...loadLegacySupabaseConfig(envPath) });
  }
  return Object.freeze({
    ...common,
    gatewayUrl: normalizeHttpsUrl(process.env.HODPRO_API_BASE || DEFAULT_GATEWAY_URL, "HODPRO_API_BASE"),
    configSource: envPath ? ".env" : "gateway padrão"
  });
}

export const __testing = { normalizeHttpsUrl, validateAccessToken };
