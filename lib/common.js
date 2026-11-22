// Shared hardening helpers for index.js and aggregate.js.
//
// Every upstream (the ransomware.live API and each of the curated news feeds)
// is treated as hostile: responses are size- and time-bounded, text is
// stripped of characters that break XML or disguise what a string says, and
// links are only published when they are plain https URLs on expected hosts.
// Zero runtime dependencies; Node 18+.

/** Hard caps on what one upstream may make this process download. */
const API_MAX_BYTES = 8 * 1024 * 1024;
const FEED_MAX_BYTES = 5 * 1024 * 1024;
/** Deadline for one request including its body; FEED_FETCH_TIMEOUT_MS overrides it (used by the tests). */
const FETCH_TIMEOUT_MS = Number(process.env.FEED_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.FEED_FETCH_TIMEOUT_MS) : 20_000;
const LINK_MAX = 2048;

/**
 * Characters that must not reach an output file:
 *   - C0 and C1 controls and DEL (most are illegal in XML 1.0; all are noise)
 *   - zero-width characters, line and paragraph separators, and the
 *     bidirectional overrides and isolates used to make text render as
 *     something other than what it says
 *   - the noncharacters U+FFFE and U+FFFF (illegal in XML 1.0)
 * Lone surrogates are handled separately (they are not valid UTF-16).
 */
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufffe\uffff]/g;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * One line of safe text: strings and numbers only (anything else becomes ''),
 * unsafe characters turned into spaces, whitespace collapsed, trimmed, and
 * cut to `max` characters without splitting a surrogate pair.
 */
function cleanText(value, max = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let text = String(value);
  // Bound the work before any regex runs over it.
  if (text.length > max * 8) text = text.slice(0, max * 8);
  text = text.replace(LONE_SURROGATE_RE, ' ').replace(UNSAFE_TEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text;
}

/** Escape for XML and HTML text and attribute values, after removing what XML 1.0 forbids. */
function esc(value) {
  return String(value ?? '')
    .replace(LONE_SURROGATE_RE, '')
    .replace(UNSAFE_TEXT_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "example.co" style site key: the last two labels of a hostname (an approximation, no public suffix list). */
function siteOf(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

/**
 * Returns the normalized URL if `value` is a plain absolute https URL, else ''.
 * Rejected: any other scheme (javascript:, data:, http:, protocol-relative),
 * control or whitespace characters anywhere, userinfo (`https://good@evil/`),
 * an explicit port, and anything over LINK_MAX characters.
 * Options:
 *   hosts     exact hostnames the URL must be on
 *   sites     site keys (see siteOf) the URL's host must belong to
 */
function httpsUrl(value, { hosts, sites } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LINK_MAX) return '';
  if (/[\u0000- \u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(value)) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
  const host = url.hostname.toLowerCase();
  if (!host || host.endsWith('.')) return '';
  if (hosts || sites) {
    const onHost = Array.isArray(hosts) && hosts.includes(host);
    const onSite = Array.isArray(sites) && sites.includes(siteOf(host));
    if (!onHost && !onSite) return '';
  }
  return url.href;
}

/** A bare hostname such as "example.com" (lowercased), or ''. */
function cleanHostname(value) {
  if (typeof value !== 'string') return '';
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return '';
  return host;
}

/**
 * GET a URL as text with a deadline and a hard size cap. The body is read as
 * a stream and abandoned the moment it passes `maxBytes` (after any
 * decompression), so no upstream can make this process hold more than that.
 */
async function fetchText(url, { headers = {}, maxBytes, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`responded ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`response larger than ${maxBytes} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

module.exports = {
  API_MAX_BYTES,
  FEED_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  LINK_MAX,
  cleanHostname,
  cleanText,
  esc,
  fetchText,
  httpsUrl,
  siteOf,
};
