/**
 * Session-data adapters for Playwright.
 *
 * Diagnostics intentionally contain only stable codes and positions. They never
 * copy cookie values, storage values, proxy URLs, or proxy credentials.
 */

const JSON_CONTAINER_PREFIX = /^[\[{]/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks4:',
  'socks5:',
]);
const MAX_COOKIE_EXPIRATION_SECONDS = 253_402_300_799;

export class SessionDataError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'SessionDataError';
    this.code = code;
  }
}

/**
 * Accepts a value that is already decoded, JSON text, or JSON encoded twice.
 * Parse failures use a deliberately generic error message so input secrets do
 * not end up in logs.
 */
export function parseJsonish(input, { fallback = null, maxDepth = 2 } = {}) {
  if (input === null || input === undefined) return fallback;
  if (typeof input !== 'string') return input;

  let current = input.trim();
  if (current === '') return fallback;

  const depthLimit = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : 1;

  for (let depth = 0; depth < depthLimit; depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      throw new SessionDataError(
        'invalid_json',
        'Os dados de sessao nao contem JSON valido.',
      );
    }

    if (typeof current !== 'string') return current;

    const candidate = current.trim();
    if (!JSON_CONTAINER_PREFIX.test(candidate)) return current;
    current = candidate;
  }

  return current;
}

function diagnostic(code, field, index) {
  const result = { code, field };
  if (Number.isInteger(index)) result.index = index;
  return Object.freeze(result);
}

function decodeContainer(input, field, diagnostics) {
  try {
    return parseJsonish(input, { fallback: null });
  } catch {
    diagnostics.push(diagnostic(`${field}_invalid_json`, field));
    return null;
  }
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === '') {
      return false;
    }
  }

  return fallback;
}

function nowInSeconds(now) {
  const raw = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(raw)) return Date.now() / 1000;
  return raw > 100_000_000_000 ? raw / 1000 : raw;
}

function normalizeSameSite(value) {
  if (value === null || value === undefined || value === '') {
    return { value: undefined, valid: true };
  }

  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'lax') return { value: 'Lax', valid: true };
  if (normalized === 'strict') return { value: 'Strict', valid: true };
  if (normalized === 'none' || normalized === 'norestriction') {
    return { value: 'None', valid: true };
  }
  if (normalized === 'unspecified') return { value: undefined, valid: true };
  return { value: undefined, valid: false };
}

function normalizeDomain(value, hostOnly) {
  if (typeof value !== 'string') return null;

  const original = value.trim().toLowerCase();
  if (original === '' || CONTROL_CHARACTER.test(original)) return null;
  if (original.includes('/') || original.includes('@') || original.includes(':')) {
    return null;
  }

  const hadLeadingDot = original.startsWith('.');
  const bareDomain = original.replace(/^\.+/, '').replace(/\.$/, '');
  if (bareDomain === '' || bareDomain.includes('..')) return null;

  // URL parsing handles IDNs and rejects most malformed host names. Cookie
  // domains cannot contain a port, path, credentials, or wildcard.
  let hostname;
  try {
    const parsed = new URL(`http://${bareDomain}`);
    hostname = parsed.hostname;
  } catch {
    return null;
  }

  if (!hostname || hostname.includes(':')) return null;
  if (booleanValue(hostOnly, false)) return hostname;
  const explicitlyNotHostOnly =
    hostOnly === false ||
    hostOnly === 0 ||
    (typeof hostOnly === 'string' &&
      ['false', 'no', '0'].includes(hostOnly.trim().toLowerCase()));
  return hadLeadingDot || explicitlyNotHostOnly
    ? `.${hostname}`
    : hostname;
}

function normalizeCookieUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;

  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function cookieArray(container) {
  if (Array.isArray(container)) return container;
  if (container && typeof container === 'object') {
    if (Array.isArray(container.cookies)) return container.cookies;
    if ('name' in container || 'value' in container) return [container];
  }
  return null;
}

/**
 * Converts Chrome-export cookies to the shape accepted by
 * BrowserContext.addCookies().
 */
export function normalizeCookies(
  input,
  { now = Date.now(), defaultUrl } = {},
) {
  const diagnostics = [];
  const decoded = decodeContainer(input, 'cookies', diagnostics);

  if (decoded === null) return { cookies: [], diagnostics };

  const sourceCookies = cookieArray(decoded);
  if (!sourceCookies) {
    diagnostics.push(diagnostic('cookies_invalid_container', 'cookies'));
    return { cookies: [], diagnostics };
  }

  const currentEpoch = nowInSeconds(now);
  const cookies = [];

  sourceCookies.forEach((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      diagnostics.push(diagnostic('cookie_invalid_record', 'cookies', index));
      return;
    }

    if (typeof source.name !== 'string' || !COOKIE_NAME.test(source.name)) {
      diagnostics.push(diagnostic('cookie_invalid_name', 'cookies', index));
      return;
    }

    const valueType = typeof source.value;
    if (
      source.value === null ||
      source.value === undefined ||
      !['string', 'number', 'boolean', 'bigint'].includes(valueType)
    ) {
      diagnostics.push(diagnostic('cookie_invalid_value', 'cookies', index));
      return;
    }

    const cookie = {
      name: source.name,
      value: String(source.value),
    };

    const rawDomain = source.domain;
    const domain = normalizeDomain(rawDomain, source.hostOnly);
    const hasExportedDomain =
      typeof rawDomain === 'string' && rawDomain.trim() !== '';
    const url = normalizeCookieUrl(
      source.url ?? (hasExportedDomain ? null : defaultUrl),
    );

    if (domain) {
      const path = source.path === undefined || source.path === null
        ? '/'
        : String(source.path);
      if (!path.startsWith('/') || CONTROL_CHARACTER.test(path)) {
        diagnostics.push(diagnostic('cookie_invalid_path', 'cookies', index));
        return;
      }
      cookie.domain = domain;
      cookie.path = path;
    } else if (url) {
      cookie.url = url;
    } else {
      diagnostics.push(diagnostic('cookie_missing_scope', 'cookies', index));
      return;
    }

    const isSession = booleanValue(source.session, false);
    const rawExpiration = source.expirationDate ?? source.expires;
    if (!isSession && rawExpiration !== undefined && rawExpiration !== null && rawExpiration !== '') {
      let expiration = Number(rawExpiration);
      if (!Number.isFinite(expiration)) {
        diagnostics.push(diagnostic('cookie_invalid_expiration', 'cookies', index));
        return;
      }

      // Chrome extensions are found in the wild exporting either Unix seconds
      // or JavaScript milliseconds. Playwright exclusively accepts seconds.
      if (expiration > 1_000_000_000_000) expiration /= 1000;

      // Playwright uses -1 for a session cookie in exported storage state.
      if (expiration !== -1) {
        if (expiration <= 0 || expiration > MAX_COOKIE_EXPIRATION_SECONDS) {
          diagnostics.push(diagnostic('cookie_invalid_expiration', 'cookies', index));
          return;
        }
        if (expiration <= currentEpoch) {
          diagnostics.push(diagnostic('cookie_expired', 'cookies', index));
          return;
        }
        cookie.expires = expiration;
      }
    }

    cookie.httpOnly = booleanValue(source.httpOnly, false);
    cookie.secure = booleanValue(source.secure, false);

    const sameSite = normalizeSameSite(source.sameSite);
    if (!sameSite.valid) {
      diagnostics.push(diagnostic('cookie_invalid_same_site', 'cookies', index));
    } else if (sameSite.value) {
      cookie.sameSite = sameSite.value;
    }

    // With url scope Playwright derives Secure from the URL, overriding the
    // provided field. Domain/path cookies retain the exported Secure flag.
    const effectiveSecure = cookie.url
      ? new URL(cookie.url).protocol === 'https:'
      : cookie.secure;
    const isHostOnly = booleanValue(source.hostOnly, false) || Boolean(cookie.url);
    const cookiePath = source.path === undefined || source.path === null
      ? '/'
      : String(source.path);

    if (source.name.startsWith('__Secure-') && !effectiveSecure) {
      diagnostics.push(diagnostic('cookie_secure_prefix_requires_secure', 'cookies', index));
      return;
    }

    if (
      source.name.startsWith('__Host-') &&
      (!effectiveSecure || !isHostOnly || cookiePath !== '/')
    ) {
      diagnostics.push(diagnostic('cookie_invalid_host_prefix', 'cookies', index));
      return;
    }

    if (sameSite.value === 'None' && !effectiveSecure) {
      diagnostics.push(diagnostic('cookie_same_site_none_requires_secure', 'cookies', index));
      return;
    }

    if (source.partitionKey !== undefined && source.partitionKey !== null) {
      if (typeof source.partitionKey !== 'string' || source.partitionKey === '') {
        diagnostics.push(diagnostic('cookie_invalid_partition_key', 'cookies', index));
        return;
      }
      cookie.partitionKey = source.partitionKey;
    }

    cookies.push(cookie);
  });

  return { cookies, diagnostics };
}

function serializeStorageValue(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (['number', 'boolean', 'bigint'].includes(typeof value)) return String(value);
  if (typeof value !== 'object') return null;

  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

function storageTuples(container) {
  if (Array.isArray(container)) {
    return container.map((entry) => {
      if (Array.isArray(entry) && entry.length >= 2) return [entry[0], entry[1]];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return [entry.name ?? entry.key, entry.value];
      }
      return null;
    });
  }

  if (container && typeof container === 'object') return Object.entries(container);
  return null;
}

/**
 * Normalizes localStorage/sessionStorage maps or arrays to Playwright-style
 * string pairs: [{ name, value }]. Duplicate names use the last value.
 */
export function normalizeStorage(input, { field = 'storage' } = {}) {
  const diagnostics = [];
  const decoded = decodeContainer(input, field, diagnostics);
  if (decoded === null) return { entries: [], diagnostics };

  const tuples = storageTuples(decoded);
  if (!tuples) {
    diagnostics.push(diagnostic(`${field}_invalid_container`, field));
    return { entries: [], diagnostics };
  }

  const byName = new Map();
  tuples.forEach((tuple, index) => {
    if (!tuple || (typeof tuple[0] !== 'string' && typeof tuple[0] !== 'number')) {
      diagnostics.push(diagnostic(`${field}_invalid_entry`, field, index));
      return;
    }

    const name = String(tuple[0]);
    const value = serializeStorageValue(tuple[1]);
    if (value === null) {
      diagnostics.push(diagnostic(`${field}_invalid_value`, field, index));
      return;
    }

    if (byName.has(name)) {
      diagnostics.push(diagnostic(`${field}_duplicate_entry`, field, index));
    }
    byName.set(name, value);
  });

  return {
    entries: [...byName].map(([name, value]) => ({ name, value })),
    diagnostics,
  };
}

function safelyDecodeCredential(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SessionDataError(
      'invalid_proxy_credentials',
      'As credenciais do proxy nao sao validas.',
    );
  }
}

/**
 * Parses proxy_url into Playwright's { server, username, password } shape.
 * `password` is deliberately non-enumerable, keeping it out of JSON.stringify,
 * object inspection, and ordinary logs. Pass this object directly to Playwright
 * instead of spreading it.
 */
export function parseProxyUrl(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string') {
    throw new SessionDataError('invalid_proxy_url', 'A URL do proxy nao e valida.');
  }

  const candidate = input.includes('://') ? input : `http://${input}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new SessionDataError('invalid_proxy_url', 'A URL do proxy nao e valida.');
  }

  if (
    !SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol) ||
    !parsed.hostname ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new SessionDataError('invalid_proxy_url', 'A URL do proxy nao e valida.');
  }

  if (
    ['socks4:', 'socks5:'].includes(parsed.protocol) &&
    (parsed.username !== '' || parsed.password !== '')
  ) {
    throw new SessionDataError(
      'unsupported_proxy_auth',
      'O Playwright nao aceita autenticacao neste tipo de proxy.',
    );
  }

  const proxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username !== '') proxy.username = safelyDecodeCredential(parsed.username);

  if (parsed.password !== '') {
    const password = safelyDecodeCredential(parsed.password);
    Object.defineProperty(proxy, 'password', {
      configurable: false,
      enumerable: false,
      value: password,
      writable: false,
    });
  }

  return proxy;
}

/**
 * Normalizes the session-related columns returned by the account query.
 */
export function normalizeSessionData(record, options = {}) {
  const decodedRecord = parseJsonish(record, { fallback: {} });
  if (!decodedRecord || typeof decodedRecord !== 'object' || Array.isArray(decodedRecord)) {
    throw new SessionDataError(
      'invalid_session_record',
      'O registro de sessao nao e valido.',
    );
  }

  const cookieResult = normalizeCookies(
    decodedRecord.cookies_json ?? decodedRecord.cookies,
    { now: options.now, defaultUrl: options.defaultUrl },
  );
  const localResult = normalizeStorage(decodedRecord.local_storage, {
    field: 'local_storage',
  });
  const sessionResult = normalizeStorage(decodedRecord.session_storage, {
    field: 'session_storage',
  });

  const diagnostics = [
    ...cookieResult.diagnostics,
    ...localResult.diagnostics,
    ...sessionResult.diagnostics,
  ];

  let proxy = null;
  try {
    proxy = parseProxyUrl(decodedRecord.proxy_url);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        error instanceof SessionDataError ? error.code : 'invalid_proxy_url',
        'proxy_url',
      ),
    );
  }

  return {
    cookies: cookieResult.cookies,
    localStorage: localResult.entries,
    sessionStorage: sessionResult.entries,
    proxy,
    diagnostics,
  };
}
