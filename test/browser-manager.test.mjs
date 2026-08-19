import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  __testing,
  cookieMatchesAllowedHosts,
  isLoginDestination,
  persistentProfileDirectory,
  validateLaunchUrl
} from "../src/browser-manager.mjs";
import { SafeAppError } from "../src/supabase.mjs";

test("validateLaunchUrl aceita HTTPS e HTTP somente em loopback", () => {
  assert.equal(validateLaunchUrl("https://app.example.com/home").protocol, "https:");
  assert.equal(validateLaunchUrl("http://127.0.0.1:4317").hostname, "127.0.0.1");
  assert.throws(
    () => validateLaunchUrl("http://app.example.com"),
    (error) => error instanceof SafeAppError && error.code === "UNSAFE_LAUNCH_URL"
  );
  assert.throws(() => validateLaunchUrl("javascript:alert(1)"), SafeAppError);
});

test("cookieMatchesAllowedHosts limita cookies ao domínio da ferramenta", () => {
  const allowed = ["app.example.com", "login.example.net"];
  assert.equal(
    cookieMatchesAllowedHosts({ domain: ".example.com" }, allowed),
    true
  );
  assert.equal(
    cookieMatchesAllowedHosts({ domain: "login.example.net" }, allowed),
    true
  );
  assert.equal(
    cookieMatchesAllowedHosts({ url: "https://app.example.com/" }, allowed),
    true
  );
  assert.equal(
    cookieMatchesAllowedHosts({ domain: ".unrelated.example" }, allowed),
    false
  );
});

test("isLoginDestination reconhece redirecionamentos para autenticação", () => {
  assert.equal(
    isLoginDestination("https://app.example.com/auth/login?redirect=%2Fdashboard", {
      loginUrl: "https://app.example.com/auth/login"
    }),
    true
  );
  assert.equal(
    isLoginDestination("https://app.example.com/#/sign-in"),
    true
  );
  assert.equal(
    isLoginDestination("https://app.example.com/dashboard", {
      loginUrl: "https://app.example.com/auth/login"
    }),
    false
  );
});

test("persistentProfileDirectory mantém profileKey não confiável dentro da raiz", () => {
  const root = path.resolve("test-output", "profiles");
  const directory = persistentProfileDirectory(
    root,
    {
      id: "account-1",
      profileKey: "../../fora\\perfil\u0000sensível",
      tool: { id: "tool-1" }
    },
    new URL("https://app.example.com")
  );

  assert.equal(path.dirname(directory), root);
  assert.match(path.basename(directory), /^[a-f0-9]{64}$/);
  assert.equal(directory.includes("fora"), false);
  assert.notEqual(
    directory,
    persistentProfileDirectory(
      root,
      { id: "account-2", profileKey: "../../fora", tool: { id: "tool-1" } },
      new URL("https://app.example.com")
    )
  );
});

test("allowedOrigins amplia somente a lista explícita de origens seguras", () => {
  const urls = __testing.allowedUrlsFor(
    {
      allowedOrigins: [
        "https://login.example.net/path",
        "http://inseguro.example.org",
        "javascript:alert(1)"
      ],
      tool: {
        baseUrl: "https://app.example.com/dashboard",
        loginUrl: "https://app.example.com/login"
      }
    },
    new URL("https://app.example.com/dashboard")
  );

  assert.deepEqual(
    urls.map((url) => url.origin),
    ["https://app.example.com", "https://login.example.net"]
  );
});

test("IndexedDB só é aceito quando o bundle traz schema completo", () => {
  assert.deepEqual(
    __testing.normalizeCompleteIndexedDb({
      legacyDb: { version: 1, stores: { tokens: [{ key: "a", value: "b" }] } }
    }),
    []
  );

  const complete = __testing.normalizeCompleteIndexedDb({
    databases: [{
      name: "auth-db",
      version: 2,
      stores: [{
        name: "tokens",
        keyPath: "id",
        autoIncrement: false,
        indexes: [{ name: "by_kind", keyPath: "kind", unique: false }],
        records: [{ value: { id: "primary", kind: "access", token: "fictício" } }]
      }]
    }]
  });

  assert.equal(complete.length, 1);
  assert.equal(complete[0].stores[0].keyPath, "id");
  assert.equal(complete[0].stores[0].records.length, 1);
});

test("loginScript exige confiança e recebe credenciais somente como argumento", async () => {
  const evaluations = [];
  const page = {
    async evaluate(_function, payload) {
      evaluations.push(payload);
    }
  };
  const account = {
    loginScript: "document.body.dataset.email = '{{email}}'",
    loginArgs: {
      email: "usuario@lab.local",
      password: "segredo-fictício"
    }
  };

  assert.deepEqual(
    await __testing.executeTrustedLoginScript(page, account),
    { executed: false, succeeded: false }
  );
  assert.equal(evaluations.length, 0);

  const result = await __testing.executeTrustedLoginScript(page, {
    ...account,
    trustedLoginScript: true
  });
  assert.deepEqual(result, { executed: true, succeeded: true });
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].source.includes("segredo-fictício"), false);
  assert.equal(evaluations[0].args.password, "segredo-fictício");

  const failed = await __testing.executeTrustedLoginScript(
    { async evaluate() { throw new Error("segredo-fictício"); } },
    { ...account, trustedLoginScript: true }
  );
  assert.deepEqual(failed, { executed: true, succeeded: false });
});

test("fill-missing preserva cookies existentes e replace é explícito", async () => {
  const context = {
    async cookies() {
      return [{ name: "sid", domain: "app.example.com", path: "/" }];
    }
  };
  const bundle = [
    { name: "sid", value: "antigo", domain: "app.example.com", path: "/" },
    { name: "novo", value: "valor", domain: "app.example.com", path: "/" }
  ];

  assert.deepEqual(
    (await __testing.cookiesToSeed(context, bundle, "fill-missing")).map((item) => item.name),
    ["novo"]
  );
  assert.equal((await __testing.cookiesToSeed(context, bundle, "replace")).length, 2);
});
