import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
