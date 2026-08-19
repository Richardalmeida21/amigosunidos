import test from "node:test";
import assert from "node:assert/strict";
import {
  SafeAppError,
  SupabaseRepository,
  __testing
} from "../src/supabase.mjs";

function config() {
  return {
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "sb_publishable_fake",
    accessToken: null,
    accountsTable: "tool_accounts",
    toolsRelation: "tools",
    accountLimit: 25
  };
}

test("listAccounts retorna somente metadados seguros", async () => {
  let requestedUrl;
  let requestedOptions;
  const repository = new SupabaseRepository(config(), async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return new Response(
      JSON.stringify([
        {
          id: "d35c9089-8e09-4d7d-a9c2-09985aadc936",
          account_name: "Conta fictícia",
          login_method: "cookie",
          is_active: true,
          worker_tag: "perfil 1",
          updated_at: "2026-01-01T00:00:00Z",
          cookies_json: [{ name: "não-deve-sair", value: "segredo" }],
          credentials_json: { password: "segredo" },
          tools: {
            id: "91dcff62-62eb-4971-9719-f58406c7c397",
            name: "Ferramenta",
            base_url: "https://app.example.com/?token=magic-secret",
            login_url: null,
            is_active: true
          }
        }
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const accounts = await repository.listAccounts();

  assert.deepEqual(Object.keys(accounts[0]), [
    "id",
    "accountName",
    "loginMethod",
    "isActive",
    "workerTag",
    "updatedAt",
    "tool",
    "canOpen"
  ]);
  assert.equal(JSON.stringify(accounts).includes("segredo"), false);
  assert.equal(JSON.stringify(accounts).includes("magic-secret"), false);
  assert.equal(accounts[0].tool.hostname, "app.example.com");
  assert.equal(accounts[0].tool.hasLaunchUrl, true);
  assert.equal(accounts[0].canOpen, true);
  assert.equal("baseUrl" in accounts[0].tool, false);
  assert.equal(requestedUrl.searchParams.get("select").includes("cookies_json"), false);
  assert.equal(requestedUrl.searchParams.get("select").includes("credentials_json"), false);
  assert.equal(requestedOptions.headers.apikey, "sb_publishable_fake");
  assert.equal(requestedOptions.headers["Cache-Control"], "no-cache, no-store");
  assert.equal(requestedOptions.cache, "no-store");
  assert.equal("Authorization" in requestedOptions.headers, false);
});

test("getAccountSession busca uma conta sem consultar credentials_json", async () => {
  let select;
  const repository = new SupabaseRepository(config(), async (url) => {
    select = url.searchParams.get("select");
    return new Response(
      JSON.stringify([
        {
          id: "d35c9089-8e09-4d7d-a9c2-09985aadc936",
          account_name: "Conta",
          login_method: "cookie",
          is_active: true,
          updated_at: "2026-08-19T20:00:00Z",
          cookies_json: [],
          local_storage: {},
          session_storage: {},
          proxy_url: null,
          user_agent: "Fake browser user agent",
          tools: {
            id: "91dcff62-62eb-4971-9719-f58406c7c397",
            name: "Ferramenta",
            base_url: "https://app.example.com/"
          }
        }
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  const result = await repository.getAccountSession(
    "d35c9089-8e09-4d7d-a9c2-09985aadc936"
  );

  assert.equal(result.accountName, "Conta");
  assert.equal(result.canOpen, true);
  assert.equal(result.updatedAt, "2026-08-19T20:00:00Z");
  assert.equal(select.includes("cookies_json"), true);
  assert.equal(select.includes("updated_at"), true);
  assert.equal(select.includes("credentials_json"), false);
  assert.equal(select.includes("indexed_db"), false);
});

test("flags do catálogo e login_method não bloqueiam uma conta com URL", () => {
  const account = {
    isActive: true,
    loginMethod: "auto_login",
    tool: {
      hasLaunchUrl: true,
      isActive: false,
      isHidden: true,
      inMaintenance: true
    }
  };

  assert.equal(__testing.isAccountLaunchable(account), true);
  assert.equal(__testing.isAccountLaunchable({ ...account, isActive: false }), false);
  assert.equal(
    __testing.isAccountLaunchable({ ...account, tool: { hasLaunchUrl: false } }),
    false
  );
});

test("erros HTTP não expõem chave publicável", async () => {
  const repository = new SupabaseRepository(config(), async () =>
    new Response(JSON.stringify({ message: "permission denied" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })
  );

  await assert.rejects(
    repository.listAccounts(),
    (error) => {
      assert.ok(error instanceof SafeAppError);
      assert.equal(error.message.includes("sb_publishable_fake"), false);
      assert.equal(error.code, "SUPABASE_HTTP_401");
      return true;
    }
  );
});

test("resumo rejeita URL HTTP remota e URL com credenciais", () => {
  for (const base_url of [
    "http://remote.example.com/",
    "https://usuario:senha@example.com/"
  ]) {
    const tool = __testing.summarizeTool({
      name: "Ferramenta",
      base_url,
      is_active: true
    });
    assert.equal(tool.hasLaunchUrl, false);
    assert.equal(tool.hostname, null);
  }
});
