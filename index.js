// Generates feed.xml, feed.json, and index.html into dist/ for GitHub Pages.
//
// Data source: the ransomware.live v2 API (recent victim claims posted by
// ransomware groups to their leak sites). The previous source, the ransomwatch
// project at ransomwhat.telemetry.ltd, was archived in 2026 and its API now
// redirects to a static farewell page, which is why the feed went stale.
//
// With RANSOMWARE_LIVE_API_KEY set (a GitHub Actions secret in CI), data comes
// from the authenticated PRO API; without it, from the free v2 endpoint. The
// PRO API intermittently rejects valid keys with a 403 (observed 2026-08-16),
// so authenticated requests retry before falling back to the free endpoint.
// (The free endpoint has answered 404 since at least 2026-10; the provider's
// docs still list it, so the URL is unchanged. See the 2026-11-22 pentest.)
//
// The API is treated as hostile input: the response is size- and time-bounded,
// every record is validated on its own (one bad record is dropped, it cannot
// abort the run), every field is bounded and cleaned, and only https links on
// www.ransomware.live are published. The strings themselves originate on
// criminal leak sites.
//
// Zero runtime dependencies; requires Node 18+ for global fetch.

const fs = require('fs/promises');
const path = require('path');
const { API_MAX_BYTES, cleanHostname, cleanText, esc, fetchText, httpsUrl } = require('./lib/common.js');

const PRO_API_URL = 'https://api-pro.ransomware.live/victims/recent';
const FREE_API_URL = 'https://api.ransomware.live/v2/recentvictims';
const RETRIES = 5;
const PAGES_URL = 'https://thestateofcybersecurity.github.io/ransomwareRSS/';
const FEED_URL = `${PAGES_URL}feed.xml`;
const SITE_URL = 'https://www.cybersecurityalphabetsoup.com/news/';
const MAX_ITEMS = 50;
/** Records looked at per response; anything beyond this is ignored. */
const MAX_RECORDS = 5000;
const LINK_HOSTS = ['www.ransomware.live'];
const FIELD_MAX = { group: 80, victim: 200, sector: 80, country: 60 };
/** Clock skew allowance: a claim dated further in the future than this is dropped. */
const MAX_FUTURE_MS = 86_400_000;
const OUT_DIR = process.env.FEED_OUT_DIR || path.join(__dirname, 'dist');

const USER_AGENT = 'ransomwareRSS (github.com/thestateofcybersecurity/ransomwareRSS)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches one URL, unwrapping the PRO envelope ({victims: [...]}) if present. */
async function fetchOnce(url, headers) {
  let text;
  try {
    text = await fetchText(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, maxBytes: API_MAX_BYTES });
  } catch (error) {
    throw new Error(`${url} ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned invalid JSON`);
  }
  const victims = Array.isArray(data) ? data : data && data.victims;
  // An empty or malformed payload must fail the attempt rather than publish an
  // empty feed over a good one.
  if (!Array.isArray(victims) || victims.length === 0) throw new Error(`${url} returned no victims`);
  return victims;
}

async function fetchVictims(apiKey = process.env.RANSOMWARE_LIVE_API_KEY || '') {
  if (apiKey) {
    // The server only honors the lowercase header name; fetch lowercases
    // header names anyway, but keep it explicit.
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      try {
        return await fetchOnce(PRO_API_URL, { 'x-api-key': apiKey });
      } catch (error) {
        console.warn(`PRO API attempt ${attempt}/${RETRIES} failed: ${error.message}`);
        if (attempt < RETRIES) await sleep(2000 * attempt);
      }
    }
    console.warn('PRO API unavailable, falling back to the free endpoint');
  }
  return fetchOnce(FREE_API_URL, {});
}

/**
 * One API record to one feed item, or null when the record is unusable.
 * Never throws: wrong types become empty strings, and a record without a
 * group or a real date is dropped on its own.
 */
function toItem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const group = cleanText(raw.group, FIELD_MAX.group);
  const when = typeof raw.discovered === 'string' || typeof raw.discovered === 'number' ? new Date(raw.discovered).getTime() : NaN;
  if (!group || !Number.isFinite(when) || when > now + MAX_FUTURE_MS) return null;
  // Victim website: `website` on the PRO API, `domain` on the free v2 API.
  // Carried in feed.json so the org-watch alert Worker can match domains
  // exactly instead of relying on name substrings.
  const domain = cleanHostname(raw.website) || cleanHostname(raw.domain);
  const sector = cleanText(raw.activity, FIELD_MAX.sector);
  return {
    group,
    victim: cleanText(raw.victim, FIELD_MAX.victim) || domain || 'Unnamed victim',
    sector: sector && sector !== 'Not Found' ? sector : '',
    country: cleanText(raw.country, FIELD_MAX.country),
    domain,
    discovered: new Date(when).toISOString(),
    // The PRO API calls the public victim page `permalink`, the free v2 API
    // calls it `url`; both point at www.ransomware.live.
    link: [raw.permalink, raw.url].map((value) => httpsUrl(value, { hosts: LINK_HOSTS })).find(Boolean) || '',
  };
}

function transform(raw, now = Date.now()) {
  const items = [];
  for (const record of raw.slice(0, MAX_RECORDS)) {
    const item = toItem(record, now);
    if (item) items.push(item);
  }
  return items.sort((a, b) => Date.parse(b.discovered) - Date.parse(a.discovered)).slice(0, MAX_ITEMS);
}

function itemDescription(item) {
  const parts = [`Ransomware group "${item.group}" listed ${item.victim} on its leak site.`];
  if (item.sector) parts.push(`Sector: ${item.sector}.`);
  if (item.country) parts.push(`Country: ${item.country}.`);
  parts.push('Claims are made by criminal extortion groups and are unverified.');
  return parts.join(' ');
}

function generateRSS(items) {
  const rssItems = items
    .map((item) => {
      const link = item.link || PAGES_URL;
      return `    <item>
      <title>${esc(`${item.group}: ${item.victim}`)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(`${item.group}/${item.victim}/${item.discovered}`)}</guid>
      <pubDate>${new Date(item.discovered).toUTCString()}</pubDate>
      <description>${esc(itemDescription(item))}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ransomware Watch</title>
    <description>Recent victim claims posted by ransomware groups, via ransomware.live. Claims are unverified.</description>
    <link>${esc(SITE_URL)}</link>
    <atom:link href="${esc(FEED_URL)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>60</ttl>
${rssItems}
  </channel>
</rss>
`;
}

function generateHTML(items) {
  const rows = items
    .map(
      (item) => `      <tr>
        <td>${esc(item.group)}</td>
        <td>${item.link ? `<a href="${esc(item.link)}" rel="noopener">${esc(item.victim)}</a>` : esc(item.victim)}</td>
        <td>${esc(item.sector)}</td>
        <td>${esc(item.country)}</td>
        <td>${esc(new Date(item.discovered).toUTCString())}</td>
      </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>Ransomware Watch</title>
  <meta name="description" content="RSS feed of recent victim claims posted by ransomware groups, sourced from ransomware.live.">
  <link rel="alternate" type="application/rss+xml" title="Ransomware Watch" href="feed.xml">
  <style>
    body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 1000px; padding: 24px 16px; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    th, td { border: 1px solid #8886; padding: 6px 10px; text-align: left; }
    a.button { display: inline-block; margin: 0 8px 16px 0; }
  </style>
</head>
<body>
  <h1>Ransomware Watch</h1>
  <p>Recent victim claims posted by ransomware groups to their leak sites, updated hourly from
    <a href="https://www.ransomware.live/" rel="noopener">ransomware.live</a>.
    All claims are made by criminal extortion groups and are unverified.</p>
  <p>
    <a class="button" href="feed.xml">Subscribe by RSS</a>
    <a class="button" href="${esc(SITE_URL)}">View on Cybersecurity Alphabet Soup</a>
  </p>
  <table>
    <thead>
      <tr><th>Group</th><th>Victim</th><th>Sector</th><th>Country</th><th>Discovered</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function main() {
  const items = transform(await fetchVictims());
  if (items.length === 0) throw new Error('No usable items after transform');

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'feed.xml'), generateRSS(items));
  await fs.writeFile(
    path.join(OUT_DIR, 'feed.json'),
    JSON.stringify({ updated: new Date().toISOString(), items }, null, 2),
  );
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), generateHTML(items));

  console.log(`Wrote ${items.length} items to ${OUT_DIR}`);
}

module.exports = { fetchOnce, fetchVictims, generateHTML, generateRSS, itemDescription, toItem, transform };

if (require.main === module) {
  main().catch((error) => {
    console.error('Feed generation failed:', error?.message || error);
    process.exitCode = 1;
  });
}
