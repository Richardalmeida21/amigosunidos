import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUTH_STORE_FILENAME,
  AuthSessionManager,
  AuthStore,
  AuthStoreError
} from "../src/auth-store.mjs";

async function temporaryUserData(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hodpro-auth-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeSafeStorage(available = true) {
  const mask = 0xa7;
  return {
    async isEncryptionAvailable() {
      return available;
    },
    async encryptString(value) {
      return Buffer.from(value, "utf8").map((byte) => byte ^ mask);
    },
    async decryptString(value) {
      return Buffer.from(value).map((byte) => byte ^ mask).toString("utf8");
    }
  };
}

function session(suffix = "one", expiresAt = Date.now() + 3_600_000) {
  return {
    accessToken: "access-test-" + suffix,
    refreshToken: "refresh-test-" + suffix,
    user: { id: "user-test", email: "person@example.test" },
    expiresAt
  };
}

test("salva atomicamente um blob criptografado sob userData e permite limpar", async (t) => {
  const userData = await temporaryUserData(t);
  const operations = [];
  const fsImpl = {
    mkdir: (...args) => fs.mkdir(...args),
    readFile: (...args) => fs.readFile(...args),
    unlink: (...args) => fs.unlink(...args),
    async open(...args) {
      operations.push({ type: "open", path: args[0] });
      return fs.open(...args);
    },
    async rename(...args) {
      operations.push({ type: "rename", from: args[0], to: args[1] });
      return fs.rename(...args);
    }
  };
  const requestedPaths = [];
  const store = new AuthStore({
    app: {
      getPath(name) {
        requestedPaths.push(name);
        return userData;
      }
    },
    safeStorage: fakeSafeStorage(),
    fsImpl,
    randomId: () => "atomic-test"
  });

  await store.save(session("one"));
  const storePath = path.join(userData, AUTH_STORE_FILENAME);
  const encrypted = await fs.readFile(storePath);
  assert.deepEqual(requestedPaths, ["userData"]);
  assert.equal(encrypted.toString("utf8").includes("access-test-one"), false);
  assert.equal(encrypted.toString("utf8").includes("refresh-test-one"), false);
  assert.equal(encrypted.toString("utf8").includes("person@example.test"), false);
  assert.deepEqual(await store.load(), session("one", (await store.load()).expiresAt));

  const rename = operations.find((operation) => operation.type === "rename");
  assert.equal(path.dirname(rename.from), userData);
  assert.equal(rename.to, storePath);
  assert.match(path.basename(rename.from), /\.tmp$/);
  assert.deepEqual(
    (await fs.readdir(userData)).filter((name) => name.endsWith(".tmp")),
    []
  );

  if (process.platform !== "win32") {
    const stat = await fs.stat(storePath);
    assert.equal(stat.mode & 0o077, 0);
  }

  await store.save(session("two"));
  assert.equal((await store.load()).accessToken, "access-test-two");
  await store.clear();
  assert.equal(await store.load(), null);
  await store.clear();
});

test("usa a API assíncrona do safeStorage e trata rotação da chave", async (t) => {
  const userData = await temporaryUserData(t);
  const mask = 0x5c;
  let encryptions = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => true,
    encryptString() {
      throw new Error("a API síncrona não deve ser usada");
    },
    decryptString() {
      throw new Error("a API síncrona não deve ser usada");
    },
    async encryptStringAsync(value) {
      encryptions += 1;
      return Buffer.from(value, "utf8").map((byte) => byte ^ mask);
    },
    async decryptStringAsync(value) {
      return {
        result: Buffer.from(value).map((byte) => byte ^ mask).toString("utf8"),
        shouldReEncrypt: true
      };
    }
  };
  const store = new AuthStore({ app: { getPath: () => userData }, safeStorage });
  await store.save(session("async"));
  assert.equal((await store.load()).accessToken, "access-test-async");
  assert.equal(encryptions, 2);
});

test("nunca usa texto claro quando a criptografia do sistema está indisponível", async (t) => {
  const userData = await temporaryUserData(t);
  const store = new AuthStore({
    app: { getPath: () => userData },
    safeStorage: fakeSafeStorage(false)
  });

  await assert.rejects(store.save(session()), (error) => {
    assert.ok(error instanceof AuthStoreError);
    assert.equal(error.code, "ENCRYPTION_UNAVAILABLE");
    return true;
  });
  await assert.rejects(store.load(), (error) => error.code === "ENCRYPTION_UNAVAILABLE");
  assert.equal(
    await fs.access(path.join(userData, AUTH_STORE_FILENAME)).then(
      () => true,
      () => false
    ),
    false
  );
});

test("erro de descriptografia é sanitizado", async (t) => {
  const userData = await temporaryUserData(t);
  const storePath = path.join(userData, AUTH_STORE_FILENAME);
  await fs.writeFile(storePath, "corrupt-private-content");
  const store = new AuthStore({
    app: { getPath: () => userData },
    safeStorage: {
      ...fakeSafeStorage(),
      async decryptString() {
        throw new Error("corrupt-private-content");
      }
    }
  });

  await assert.rejects(store.load(), (error) => {
    assert.equal(error.code, "CORRUPT_SESSION");
    assert.equal(String(error).includes("corrupt-private-content"), false);
    return true;
  });
});

class MemoryStore {
  constructor(value = null) {
    this.value = value ? structuredClone(value) : null;
    this.saves = [];
    this.clearCount = 0;
  }

  async save(value) {
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }

  async load() {
    return this.value ? structuredClone(this.value) : null;
  }

  async clear() {
    this.value = null;
    this.clearCount += 1;
  }
}

function jwt(expSeconds, suffix) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "none", typ: "JWT" }), encode({ exp: expSeconds }), suffix].join(".");
}

test("login persiste a sessão, usa a menor expiração e retorna status sem tokens", async () => {
  const now = 1_800_000_000_000;
  const accessToken = jwt(now / 1000 + 120, "login-signature");
  const store = new MemoryStore();
  const apiClient = {
    async login(email, password) {
      assert.equal(email, "person@example.test");
      assert.equal(password, "test-password");
      return {
        accessToken,
        refreshToken: "refresh-test-login",
        expiresIn: 3600,
        user: {
          id: "user-test",
          email: "person@example.test",
          full_name: "Test Person",
          refresh_token: "must-not-leak",
          password: "must-not-leak"
        }
      };
    },
    async refresh() {
      throw new Error("not expected");
    },
    async signout() {}
  };
  const manager = new AuthSessionManager({
    apiClient,
    store,
    now: () => now,
    refreshMarginMs: 60_000
  });

  const status = await manager.login("person@example.test", "test-password");
  assert.deepEqual(status, {
    authenticated: true,
    user: {
      id: "user-test",
      email: "person@example.test",
      fullName: "Test Person"
    },
    preferredEmail: "person@example.test",
    expiresAt: now + 120_000,
    needsRefresh: false
  });
  assert.equal(JSON.stringify(status).includes("refresh-test-login"), false);
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  let receivedAccessToken;
  const operationResult = await manager.withAccessToken(async (token) => {
    receivedAccessToken = token;
    return "operation-complete";
  });
  assert.equal(receivedAccessToken, accessToken);
  assert.equal(operationResult, "operation-complete");
  assert.equal(store.value.refreshToken, "refresh-test-login");
});

test("serializa refresh concorrente e persiste o par rotativo antes de usá-lo", async () => {
  const now = 1_800_000_000_000;
  const firstAccess = jwt(now / 1000 + 30, "first-signature");
  const nextAccess = jwt(now / 1000 + 3600, "next-signature");
  const store = new MemoryStore();
  let refreshCalls = 0;
  const apiClient = {
    async login() {
      return {
        accessToken: firstAccess,
        refreshToken: "refresh-test-first",
        expiresIn: 30,
        user: { id: "user-test", email: "person@example.test" }
      };
    },
    async refresh(receivedToken) {
      refreshCalls += 1;
      assert.equal(receivedToken, "refresh-test-first");
      await new Promise((resolve) => setImmediate(resolve));
      return {
        accessToken: nextAccess,
        refreshToken: "refresh-test-rotated",
        expiresIn: 3600,
        user: { id: "user-test", email: "person@example.test" }
      };
    },
    async signout() {}
  };
  const manager = new AuthSessionManager({
    apiClient,
    store,
    now: () => now,
    refreshMarginMs: 60_000
  });
  await manager.login("person@example.test", "test-password");

  const tokens = await Promise.all([
    manager.getAccessToken(),
    manager.getAccessToken(),
    manager.getAccessToken()
  ]);

  assert.equal(refreshCalls, 1);
  assert.deepEqual(tokens, [nextAccess, nextAccess, nextAccess]);
  assert.equal(store.saves.length, 2);
  assert.equal(store.value.accessToken, nextAccess);
  assert.equal(store.value.refreshToken, "refresh-test-rotated");
  assert.equal(manager.getStatus().needsRefresh, false);
});

test("restore renova sessão vencida e falha definitiva remove o par salvo", async () => {
  const now = 1_800_000_000_000;
  const expired = session("expired", now - 1);
  const store = new MemoryStore(expired);
  const authError = Object.assign(new Error("remote body must not matter"), {
    status: 401,
    code: "GATEWAY_HTTP_401"
  });
  const apiClient = {
    async login() {
      throw new Error("not expected");
    },
    async refresh(receivedToken) {
      assert.equal(receivedToken, "refresh-test-expired");
      throw authError;
    },
    async signout() {}
  };
  const manager = new AuthSessionManager({ apiClient, store, now: () => now });

  await assert.rejects(manager.restore(), (error) => error === authError);
  assert.equal(store.value, null);
  assert.equal(store.clearCount, 1);
  assert.deepEqual(manager.getStatus(), {
    authenticated: false,
    user: null,
    preferredEmail: "person@example.test",
    expiresAt: null,
    needsRefresh: false
  });
});

test("logout local sempre limpa o cofre mesmo se o gateway falhar", async () => {
  const now = 1_800_000_000_000;
  const store = new MemoryStore();
  let signoutToken = null;
  const apiClient = {
    async login() {
      return {
        accessToken: "access-test-logout",
        refreshToken: "refresh-test-logout",
        expiresIn: 3600,
        user: { id: "user-test", email: "person@example.test" }
      };
    },
    async refresh() {
      throw new Error("not expected");
    },
    async signout(token) {
      signoutToken = token;
      throw new Error("offline");
    }
  };
  const manager = new AuthSessionManager({ apiClient, store, now: () => now });
  await manager.login("person@example.test", "test-password");

  const status = await manager.logout();
  assert.equal(signoutToken, "access-test-logout");
  assert.equal(store.value, null);
  assert.equal(status.authenticated, false);
});
