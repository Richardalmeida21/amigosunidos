import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionDataError,
  normalizeCookies,
  normalizeSessionData,
  normalizeStorage,
  parseJsonish,
  parseProxyUrl,
} from '../src/session-data.mjs';

test('parseJsonish aceita objetos e JSON codificado uma ou duas vezes', () => {
  const object = { ok: true };
  assert.equal(parseJsonish(object), object);
  assert.deepEqual(parseJsonish('{"ok":true}'), object);
  assert.deepEqual(parseJsonish('"{\\"ok\\":true}"'), object);
  assert.equal(parseJsonish('   ', { fallback: 'empty' }), 'empty');
});

test('parseJsonish nao inclui o conteudo sensivel no erro', () => {
  const secret = 'token-super-secreto';
  assert.throws(
    () => parseJsonish(`{${secret}}`),
    (error) => {
      assert.ok(error instanceof SessionDataError);
      assert.equal(error.code, 'invalid_json');
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('normalizeCookies converte exportacao do Chrome para Playwright', () => {
  const now = 1_700_000_000;
  const result = normalizeCookies([
    {
      name: 'host_cookie',
      value: 'segredo-1',
      domain: '.Example.COM',
      path: '/',
      hostOnly: true,
      secure: 'true',
      httpOnly: 1,
      sameSite: 'lax',
      expirationDate: now + 3600,
    },
    {
      name: 'domain_cookie',
      value: 'segredo-2',
      domain: 'example.com',
      path: '/app',
      hostOnly: 'False',
      sameSite: 'no_restriction',
      secure: true,
    },
    {
      name: 'url_cookie',
      value: 'segredo-3',
      url: 'https://login.example.net/start',
      sameSite: 'unspecified',
      session: true,
    },
    {
      name: 'strict_cookie',
      value: 'segredo-4',
      domain: 'login.example.org',
      sameSite: 'strict',
      expires: -1,
    },
  ], { now });

  assert.deepEqual(result.cookies, [
    {
      name: 'host_cookie',
      value: 'segredo-1',
      domain: 'example.com',
      path: '/',
      expires: now + 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'domain_cookie',
      value: 'segredo-2',
      domain: '.example.com',
      path: '/app',
      httpOnly: false,
      secure: true,
      sameSite: 'None',
    },
    {
      name: 'url_cookie',
      value: 'segredo-3',
      url: 'https://login.example.net/start',
      httpOnly: false,
      secure: false,
    },
    {
      name: 'strict_cookie',
      value: 'segredo-4',
      domain: 'login.example.org',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Strict',
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('normalizeCookies filtra expirados e invalidos com diagnostico sem valores', () => {
  const secretValues = ['EXPIRADO-123', 'SEM-ESCOPO-456', 'VALOR-OBJETO-789'];
  const result = normalizeCookies([
    {
      name: 'expired',
      value: secretValues[0],
      domain: 'example.com',
      expirationDate: 100,
    },
    { name: 'missing_scope', value: secretValues[1] },
    { name: 'bad_value', value: { secret: secretValues[2] }, domain: 'example.com' },
    { name: 'bad path', value: 'x', domain: 'example.com' },
  ], { now: 200 });

  assert.deepEqual(result.cookies, []);
  assert.deepEqual(
    result.diagnostics.map(({ code, index }) => [code, index]),
    [
      ['cookie_expired', 0],
      ['cookie_missing_scope', 1],
      ['cookie_invalid_value', 2],
      ['cookie_invalid_name', 3],
    ],
  );

  const serializedDiagnostics = JSON.stringify(result.diagnostics);
  for (const secret of secretValues) {
    assert.equal(serializedDiagnostics.includes(secret), false);
  }
});

test('normalizeCookies usa defaultUrl e tolera JSON com envelope cookies', () => {
  const result = normalizeCookies(
    JSON.stringify({ cookies: [{ name: 'sid', value: 42 }] }),
    { defaultUrl: 'https://example.com/account' },
  );

  assert.deepEqual(result.cookies, [{
    name: 'sid',
    value: '42',
    url: 'https://example.com/account',
    httpOnly: false,
    secure: false,
  }]);
});

test('normalizeCookies nao redireciona dominio exportado invalido ao defaultUrl', () => {
  const result = normalizeCookies(
    [{ name: 'sid', value: 'valor-ficticio', domain: 'dominio:invalido' }],
    { defaultUrl: 'https://example.com/' },
  );

  assert.deepEqual(result.cookies, []);
  assert.equal(result.diagnostics[0].code, 'cookie_missing_scope');
});

test('normalizeCookies converte expiracao em milissegundos e preserva partitionKey', () => {
  const nowSeconds = 1_700_000_000;
  const futureSeconds = nowSeconds + 3600;
  const result = normalizeCookies([
    {
      name: 'partitioned',
      value: 'valor-sensivel',
      domain: '.third-party.example',
      path: '/',
      secure: true,
      sameSite: 'no_restriction',
      expirationDate: futureSeconds * 1000,
      partitionKey: 'https://top-level.example',
    },
    {
      name: 'expired_ms',
      value: 'outro-valor-sensivel',
      domain: 'example.com',
      expirationDate: (nowSeconds - 10) * 1000,
    },
  ], { now: nowSeconds });

  assert.deepEqual(result.cookies, [{
    name: 'partitioned',
    value: 'valor-sensivel',
    domain: '.third-party.example',
    path: '/',
    expires: futureSeconds,
    httpOnly: false,
    secure: true,
    sameSite: 'None',
    partitionKey: 'https://top-level.example',
  }]);
  assert.deepEqual(result.diagnostics, [{
    code: 'cookie_expired',
    field: 'cookies',
    index: 1,
  }]);
});

test('normalizeCookies valida prefixos e SameSite=None sem vazar dados', () => {
  const secrets = [
    'secure-inseguro',
    'host-domain-cookie',
    'host-caminho-invalido',
    'none-inseguro',
    'partition-key-invalida',
  ];
  const result = normalizeCookies([
    {
      name: '__Secure-invalid',
      value: secrets[0],
      domain: 'example.com',
      secure: false,
    },
    {
      name: '__Host-invalid-domain',
      value: secrets[1],
      domain: 'example.com',
      path: '/',
      hostOnly: false,
      secure: true,
    },
    {
      name: '__Host-invalid-path',
      value: secrets[2],
      domain: 'example.com',
      path: '/app',
      hostOnly: true,
      secure: true,
    },
    {
      name: 'none_without_secure',
      value: secrets[3],
      domain: 'example.com',
      sameSite: 'none',
      secure: false,
    },
    {
      name: 'bad_partition_key',
      value: secrets[4],
      domain: 'example.com',
      partitionKey: { topLevelSite: 'https://top-level.example' },
    },
    {
      name: '__Secure-valid',
      value: 'valid-1',
      domain: '.example.com',
      secure: true,
    },
    {
      name: '__Host-valid',
      value: 'valid-2',
      domain: '.example.com',
      path: '/',
      hostOnly: true,
      secure: true,
    },
  ]);

  assert.deepEqual(
    result.cookies.map(({ name, domain, path }) => ({ name, domain, path })),
    [
      { name: '__Secure-valid', domain: '.example.com', path: '/' },
      { name: '__Host-valid', domain: 'example.com', path: '/' },
    ],
  );
  assert.deepEqual(result.diagnostics.map(({ code, index }) => [code, index]), [
    ['cookie_secure_prefix_requires_secure', 0],
    ['cookie_invalid_host_prefix', 1],
    ['cookie_invalid_host_prefix', 2],
    ['cookie_same_site_none_requires_secure', 3],
    ['cookie_invalid_partition_key', 4],
  ]);

  const diagnostics = JSON.stringify(result.diagnostics);
  for (const secret of secrets) assert.equal(diagnostics.includes(secret), false);
});

test('normalizeStorage produz pares string e mantem o ultimo duplicado', () => {
  const fromObject = normalizeStorage({
    text: 'abc',
    count: 3,
    enabled: true,
    nested: { id: 7 },
    empty: null,
  });
  assert.deepEqual(fromObject.entries, [
    { name: 'text', value: 'abc' },
    { name: 'count', value: '3' },
    { name: 'enabled', value: 'true' },
    { name: 'nested', value: '{"id":7}' },
    { name: 'empty', value: 'null' },
  ]);

  const fromArray = normalizeStorage([
    ['theme', 'light'],
    { key: 'theme', value: 'dark' },
    { name: 'flags', value: [1, 2] },
  ], { field: 'local_storage' });
  assert.deepEqual(fromArray.entries, [
    { name: 'theme', value: 'dark' },
    { name: 'flags', value: '[1,2]' },
  ]);
  assert.equal(fromArray.diagnostics[0].code, 'local_storage_duplicate_entry');
});

test('parseProxyUrl separa credenciais e nao enumera nem serializa a senha', () => {
  const password = 'senha muito secreta';
  const proxy = parseProxyUrl(
    `http://usuario:${encodeURIComponent(password)}@proxy.example.com:8080`,
  );

  assert.equal(proxy.server, 'http://proxy.example.com:8080');
  assert.equal(proxy.username, 'usuario');
  assert.equal(proxy.password, password);
  assert.equal(Object.keys(proxy).includes('password'), false);
  assert.equal(JSON.stringify(proxy).includes(password), false);
  assert.equal(JSON.stringify(proxy).includes(encodeURIComponent(password)), false);
});

test('parseProxyUrl aceita proxy sem esquema e erros nao revelam a entrada', () => {
  assert.deepEqual(parseProxyUrl('proxy.example.com:3128'), {
    server: 'http://proxy.example.com:3128',
  });

  const secret = 'senha-que-nao-pode-vazar';
  assert.throws(
    () => parseProxyUrl(`http://user:${secret}@`),
    (error) => {
      assert.ok(error instanceof SessionDataError);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('parseProxyUrl recusa autenticacao em proxy SOCKS antes do navegador', () => {
  assert.throws(
    () => parseProxyUrl('socks5://usuario:senha@proxy.example.com:1080'),
    (error) => {
      assert.ok(error instanceof SessionDataError);
      assert.equal(error.code, 'unsupported_proxy_auth');
      assert.equal(error.message.includes('senha'), false);
      return true;
    },
  );
});

test('normalizeSessionData agrega cookies, storages, proxy e diagnosticos', () => {
  const result = normalizeSessionData({
    cookies_json: [{ name: 'sid', value: 'cookie-value', domain: 'example.com' }],
    local_storage: '{"theme":"dark"}',
    session_storage: [{ name: 'step', value: 2 }],
    proxy_url: 'socks5://proxy.example.com:1080',
  });

  assert.equal(result.cookies.length, 1);
  assert.deepEqual(result.localStorage, [{ name: 'theme', value: 'dark' }]);
  assert.deepEqual(result.sessionStorage, [{ name: 'step', value: '2' }]);
  assert.deepEqual(result.proxy, { server: 'socks5://proxy.example.com:1080' });
  assert.deepEqual(result.diagnostics, []);
});
