import test from "node:test";
import assert from "node:assert/strict";
import {
  HodProApi,
  HodProApiClient,
  HodProApiError
} from "../src/hodpro-api.mjs";

const TEST_BASE_URL = "https://gateway.example.test/api";

test("exporta HodProApi e mantém o alias de cliente", () => {
  assert.equal(HodProApiClient, HodProApi);
});

function authPayload(suffix = "one") {
  return {
    access_token: "access-test-" + suffix,
    refresh_token: "refresh-test-" + suffix,
    expires_in: 3600,
    user: { id: "user-test", email: "person@example.test" }
  };
}

test("mapeia o contrato completo do gateway sem fazer chamadas reais", async () => {
  const calls = [];
  const client = new HodProApiClient({
    baseUrl: TEST_BASE_URL,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const payload = url.endsWith("/auth/login")
        ? authPayload("login")
        : url.endsWith("/auth/refresh")
          ? authPayload("refresh")
          : { success: true };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const login = await client.login("person@example.test", "test-password");
  const refresh = await client.refresh("refresh-test-login");
  await client.getUser("access-test-login");
  await client.signout("access-test-login");
  await client.verifyDevice("user-test", "device-test");
  await client.listTools();
  await client.poll("user-test");
  await client.reportLogout({
    userId: "user-test",
    userEmail: "person@example.test",
    userName: "Test Person",
    toolId: "tool-test",
    toolName: "Test Tool",
    confirmationWord: "CONFIRM",
    refresh_token: "must-not-be-forwarded"
  });
  await client.allocate("tool-test", "person@example.test");
  await client.getAccountDetails("account-test");
  await client.getAccountSession("account-test", "device-test", "access-test-login");

  assert.deepEqual(login, {
    accessToken: "access-test-login",
    refreshToken: "refresh-test-login",
    user: { id: "user-test", email: "person@example.test" },
    expiresIn: 3600
  });
  assert.equal(refresh.refreshToken, "refresh-test-refresh");

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/auth/login",
      "/api/auth/refresh",
      "/api/auth/user",
      "/api/auth/signout",
      "/api/data/verify",
      "/api/data/tools",
      "/api/data/poll",
      "/api/data/report-logout",
      "/api/tools/allocate",
      "/api/tools/details",
      "/api/tools/session"
    ]
  );
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.headers.Accept, "application/json");
    assert.equal(call.options.headers["Content-Type"], "application/json");
  }

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    email: "person@example.test",
    password: "test-password"
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    refresh_token: "refresh-test-login"
  });
  assert.equal(calls[2].options.headers.Authorization, "Bearer access-test-login");
  assert.equal(calls[3].options.headers.Authorization, "Bearer access-test-login");
  assert.equal("Authorization" in calls[4].options.headers, false);
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    user_id: "user-test",
    hwid: "device-test"
  });
  assert.deepEqual(JSON.parse(calls[7].options.body), {
    user_id: "user-test",
    user_email: "person@example.test",
    user_name: "Test Person",
    tool_id: "tool-test",
    tool_name: "Test Tool",
    confirmation_word: "CONFIRM"
  });
  assert.equal(calls[10].options.headers.Authorization, "Bearer access-test-login");
  assert.equal(calls[10].options.headers["X-HWID"], "device-test");
  assert.deepEqual(JSON.parse(calls[10].options.body), {
    account_id: "account-test",
    hwid: "device-test"
  });
});

test("exige HTTPS e uma URL base terminada em /api", () => {
  for (const baseUrl of [
    "http://gateway.example.test/api",
    "https://gateway.example.test/",
    "https://user:password@gateway.example.test/api",
    "https://gateway.example.test/api?token=secret"
  ]) {
    assert.throws(
      () => new HodProApiClient({ baseUrl, fetchImpl: async () => undefined }),
      HodProApiError
    );
  }
  assert.doesNotThrow(
    () =>
      new HodProApiClient({
        baseUrl: "https://gateway.example.test/nested/api/",
        fetchImpl: async () => undefined
      })
  );
});

test("sanitiza erro HTTP mesmo quando o servidor reflete segredos", async () => {
  const reflectedSecret = "reflected-private-value";
  const client = new HodProApiClient({
    baseUrl: TEST_BASE_URL,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: reflectedSecret, token: reflectedSecret }), {
        status: 401,
        headers: { "content-type": "application/json" }
      })
  });

  await assert.rejects(
    client.getUser("access-private-value"),
    (error) => {
      assert.ok(error instanceof HodProApiError);
      assert.equal(error.code, "GATEWAY_HTTP_401");
      assert.equal(error.status, 401);
      assert.equal(String(error).includes(reflectedSecret), false);
      assert.equal(JSON.stringify(error).includes(reflectedSecret), false);
      assert.equal(String(error).includes("access-private-value"), false);
      return true;
    }
  );
});

test("interrompe uma chamada que ultrapassa o timeout", async () => {
  const client = new HodProApiClient({
    baseUrl: TEST_BASE_URL,
    timeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })
  });

  await assert.rejects(
    client.listTools(),
    (error) => error instanceof HodProApiError && error.code === "GATEWAY_TIMEOUT"
  );
});

test("recusa resposta maior que o limite configurado", async () => {
  const client = new HodProApiClient({
    baseUrl: TEST_BASE_URL,
    maxResponseBytes: 16,
    fetchImpl: async () =>
      new Response(JSON.stringify({ value: "this-response-is-too-large" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });

  await assert.rejects(
    client.listTools(),
    (error) => error instanceof HodProApiError && error.code === "RESPONSE_TOO_LARGE"
  );
});

test("recusa JSON inválido sem reproduzir o corpo", async () => {
  const invalidBody = "not-json-private-body";
  const client = new HodProApiClient({
    baseUrl: TEST_BASE_URL,
    fetchImpl: async () =>
      new Response(invalidBody, {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });

  await assert.rejects(client.listTools(), (error) => {
    assert.equal(error.code, "INVALID_RESPONSE");
    assert.equal(String(error).includes(invalidBody), false);
    return true;
  });
});
