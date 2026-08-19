import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { BrowserManager } from "../src/browser-manager.mjs";

test("abre contexto efêmero com cookie, localStorage e sessionStorage fictícios", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Teste local</title><p>ok</p>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = "http://127.0.0.1:" + address.port + "/";
  const manager = new BrowserManager({ channel: "chrome", headless: true });
  const id = "d35c9089-8e09-4d7d-a9c2-09985aadc936";
  const account = {
    id,
    accountName: "Conta fictícia",
    loginMethod: "cookie",
    isActive: true,
    updatedAt: "2026-08-19T20:00:00Z",
    cookies: [
      {
        name: "painel_test",
        value: "valor-ficticio",
        domain: "127.0.0.1",
        path: "/",
        hostOnly: true,
        secure: false,
        httpOnly: true,
        sameSite: "lax"
      },
      {
        name: "foreign_test",
        value: "valor-ficticio",
        domain: ".unrelated.example",
        path: "/",
        secure: true
      }
    ],
    localStorage: { tema: "escuro", entrada_invalida: undefined },
    sessionStorage: { etapa: "2" },
    proxyUrl: null,
    userAgent: null,
    tool: {
      name: "Teste local",
      baseUrl,
      loginUrl: null
    }
  };

  try {
    const [result, concurrentResult] = await Promise.all([
      manager.openAccount(account),
      manager.openAccount(account)
    ]);

    assert.equal(result.cookiesApplied, 1);
    assert.equal(result.cookiesSkipped, 1);
    assert.equal(result.navigationWarning, false);
    assert.equal(concurrentResult.cookiesApplied, 1);
    assert.equal(manager.contexts.size, 1);

    const context = manager.contexts.get(id);
    const page = context.pages()[0];
    const storage = await page.evaluate(() => ({
      local: localStorage.getItem("tema"),
      session: sessionStorage.getItem("etapa")
    }));
    const cookies = await context.cookies(baseUrl);

    assert.deepEqual(storage, { local: "escuro", session: "2" });
    assert.equal(cookies.find((cookie) => cookie.name === "painel_test")?.value, "valor-ficticio");

    await page.evaluate(() => {
      localStorage.removeItem("tema");
      sessionStorage.removeItem("etapa");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    const afterReload = await page.evaluate(() => ({
      local: localStorage.getItem("tema"),
      session: sessionStorage.getItem("etapa")
    }));
    assert.deepEqual(afterReload, { local: null, session: null });

    const popupPromise = context.waitForEvent("page");
    await page.evaluate(() => {
      window.open("/popup", "_blank");
    });
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await page.close();
    assert.equal(manager.contexts.has(id), true);
    await popup.close();

    const deadline = Date.now() + 2_000;
    while (manager.contexts.has(id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(manager.contexts.has(id), false);
  } finally {
    await manager.close();
    server.close();
    await once(server, "close");
  }
});

test("reinicia uma conta, busca bundle novo e substitui o contexto antigo", async () => {
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/dashboard")) {
      if (request.headers.cookie?.includes("lab_session=fresh")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Painel autenticado</title>");
      } else {
        response.writeHead(302, { location: "/auth/login?redirect=%2Fdashboard" });
        response.end();
      }
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Login</title><input type=password>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;
  const id = "5caf1e75-481b-46d3-af8f-bc54a5d936a7";
  const manager = new BrowserManager({ channel: "chrome", headless: true });
  const account = {
    id,
    accountName: "Conta de laboratório",
    loginMethod: "cookie",
    isActive: true,
    updatedAt: "2026-08-19T20:00:00Z",
    cookies: [{
      name: "lab_session",
      value: "stale",
      domain: "127.0.0.1",
      path: "/",
      hostOnly: true
    }],
    localStorage: {},
    sessionStorage: {},
    proxyUrl: null,
    userAgent: null,
    tool: {
      name: "Laboratório",
      baseUrl: origin + "/dashboard",
      loginUrl: origin + "/auth/login"
    }
  };

  try {
    const first = await manager.openAccount(account);
    assert.equal(first.loginDetected, true);
    const oldContext = manager.contexts.get(id);
    let loads = 0;
    const loadFreshAccount = async () => {
      loads += 1;
      return {
        ...account,
        cookies: [{ ...account.cookies[0], value: "fresh" }]
      };
    };

    const [restarted, concurrentRestart] = await Promise.all([
      manager.restartAccount(id, loadFreshAccount),
      manager.restartAccount(id, loadFreshAccount)
    ]);

    assert.equal(loads, 1);
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.sessionUpdatedAt, "2026-08-19T20:00:00Z");
    assert.equal(restarted.loginDetected, false);
    assert.equal(concurrentRestart.loginDetected, false);
    assert.equal(oldContext.isClosed(), true);
    assert.equal(manager.contexts.size, 1);

    const newContext = manager.contexts.get(id);
    assert.notEqual(newContext, oldContext);
    assert.equal(new URL(newContext.pages()[0].url()).pathname, "/dashboard");
    const cookies = await newContext.cookies(origin);
    assert.equal(
      cookies.find((cookie) => cookie.name === "lab_session")?.value,
      "fresh"
    );
  } finally {
    await manager.close();
    server.close();
    await once(server, "close");
  }
});

test("perfil persistente preserva tokens renovados e replace sobrescreve explicitamente", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Perfil persistente</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = "http://127.0.0.1:" + address.port + "/";
  const profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "painel-profile-test-"));
  const manager = new BrowserManager({
    channel: "chrome",
    headless: true,
    profilesRoot
  });
  const id = "1f998616-e69a-4897-b776-91db17fd812d";
  const account = {
    id,
    persistentProfile: true,
    profileKey: "conta-local",
    cookies: [{
      name: "sid",
      value: "snapshot-antigo",
      domain: "127.0.0.1",
      path: "/",
      hostOnly: true
    }],
    localStorage: { access_token: "snapshot-antigo" },
    sessionStorage: {},
    proxyUrl: null,
    userAgent: null,
    tool: { id: "tool-local", name: "Local", baseUrl, loginUrl: null }
  };

  try {
    const [first, concurrentOpen] = await Promise.all([
      manager.openAccount(account),
      manager.openAccount(account)
    ]);
    assert.equal(first.persistentProfile, true);
    assert.equal(concurrentOpen.persistentProfile, true);
    assert.equal(manager.contexts.size, 1);
    const firstContext = manager.contexts.get(id);
    const firstPage = firstContext.pages().find((page) => page.url() === baseUrl);
    await firstPage.evaluate(() => localStorage.setItem("access_token", "renovado-pelo-site"));
    await firstContext.addCookies([{
      name: "sid",
      value: "renovado-pelo-site",
      url: baseUrl,
      expires: Math.floor(Date.now() / 1000) + 3_600
    }]);
    await manager.closeAccountContext(id);

    const reopened = await manager.openAccount(account);
    assert.equal(reopened.cookiesApplied, 0);
    assert.equal(reopened.cookiesPreserved, 1);
    const reopenedContext = manager.contexts.get(id);
    const reopenedPage = reopenedContext.pages().find((page) => page.url() === baseUrl);
    assert.equal(
      await reopenedPage.evaluate(() => localStorage.getItem("access_token")),
      "renovado-pelo-site"
    );
    assert.equal(
      (await reopenedContext.cookies(baseUrl)).find((cookie) => cookie.name === "sid")?.value,
      "renovado-pelo-site"
    );
    await manager.closeAccountContext(id);

    const replaced = await manager.openAccount({ ...account, snapshotPolicy: "replace" });
    assert.equal(replaced.cookiesApplied, 1);
    const replacedContext = manager.contexts.get(id);
    const replacedPage = replacedContext.pages().find((page) => page.url() === baseUrl);
    assert.equal(
      await replacedPage.evaluate(() => localStorage.getItem("access_token")),
      "snapshot-antigo"
    );
    assert.equal(
      (await replacedContext.cookies(baseUrl)).find((cookie) => cookie.name === "sid")?.value,
      "snapshot-antigo"
    );
  } finally {
    await manager.close();
    server.close();
    await once(server, "close");
    const resolvedTemp = path.resolve(profilesRoot);
    if (resolvedTemp.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
});

test("restaura IndexedDB com schema completo e executa loginScript confiável", async () => {
  const expectedEmail = "qa'usuario@lab.local";
  const expectedPassword = "senha-fictícia";
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url?.startsWith("/dashboard")) {
      response.end("<!doctype html><title>Dashboard local</title>");
      return;
    }
    response.end(`<!doctype html>
      <title>Login local</title>
      <form id="login"><input id="email"><input id="password" type="password"><button>Entrar</button></form>
      <script>
        document.querySelector('#login').addEventListener('submit', (event) => {
          event.preventDefault();
          if (
            document.querySelector('#email').value === ${JSON.stringify(expectedEmail)} &&
            document.querySelector('#password').value === ${JSON.stringify(expectedPassword)}
          ) location.href = '/dashboard';
        });
      </script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;
  const manager = new BrowserManager({ channel: "chrome", headless: true });
  const id = "b9974036-b12e-4760-82ec-14b51b89c27b";

  try {
    const result = await manager.openAccount({
      id,
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      indexedDB: {
        databases: [{
          name: "auth-db",
          version: 1,
          stores: [{
            name: "tokens",
            keyPath: "id",
            autoIncrement: false,
            indexes: [],
            records: [{ value: { id: "primary", token: "token-fictício" } }]
          }]
        }]
      },
      trustedLoginScript: true,
      loginScript: `
        document.querySelector('#email').value = "{{email}}";
        document.querySelector('#password').value = "{{password}}";
        document.querySelector('#login').requestSubmit();
      `,
      loginArgs: { email: expectedEmail, password: expectedPassword },
      proxyUrl: null,
      userAgent: null,
      tool: {
        id: "login-local",
        name: "Login local",
        baseUrl: origin + "/auth/login",
        loginUrl: origin + "/auth/login"
      }
    });

    assert.equal(result.indexedDbRecordsApplied, 1);
    assert.equal(result.loginScriptExecuted, true);
    assert.equal(result.loginScriptSucceeded, true);
    assert.equal(result.loginDetected, false);
    const page = manager.contexts.get(id).pages()[0];
    assert.equal(new URL(page.url()).pathname, "/dashboard");
    const storedToken = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("auth-db", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction("tokens").objectStore("tokens").get("primary");
        read.onerror = () => reject(read.error);
        read.onsuccess = () => resolve(read.result?.token);
      };
    }));
    assert.equal(storedToken, "token-fictício");
  } finally {
    await manager.close();
    server.close();
    await once(server, "close");
  }
});
