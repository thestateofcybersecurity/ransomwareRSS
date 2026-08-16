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
//
// Zero runtime dependencies; requires Node 18+ for global fetch.

const fs = require('fs/promises');
const path = require('path');

const PRO_API_URL = 'https://api-pro.ransomware.live/victims/recent';
const FREE_API_URL = 'https://api.ransomware.live/v2/recentvictims';
const API_KEY = process.env.RANSOMWARE_LIVE_API_KEY || '';
const RETRIES = 5;
const PAGES_URL = 'https://thestateofcybersecurity.github.io/ransomwareRSS/';
const FEED_URL = `${PAGES_URL}feed.xml`;
const SITE_URL = 'https://www.cybersecurityalphabetsoup.com/news/';
const MAX_ITEMS = 50;
const OUT_DIR = path.join(__dirname, 'dist');

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const USER_AGENT = 'ransomwareRSS (github.com/thestateofcybersecurity/ransomwareRSS)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches one URL, unwrapping the PRO envelope ({victims: [...]}) if present. */
async function fetchOnce(url, headers) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const data = await response.json();
  const victims = Array.isArray(data) ? data : data && data.victims;
  // An empty or malformed payload must fail the attempt rather than publish an
  // empty feed over a good one.
  if (!Array.isArray(victims) || victims.length === 0) throw new Error(`${url} returned no victims`);
  return victims;
}

async function fetchVictims() {
  if (API_KEY) {
    // The server only honours the lowercase header name; fetch lowercases
    // header names anyway, but keep it explicit.
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      try {
        return await fetchOnce(PRO_API_URL, { 'x-api-key': API_KEY });
      } catch (error) {
        console.warn(`PRO API attempt ${attempt}/${RETRIES} failed: ${error.message}`);
        if (attempt < RETRIES) await sleep(2000 * attempt);
      }
    }
    console.warn('PRO API unavailable, falling back to the free endpoint');
  }
  return fetchOnce(FREE_API_URL, {});
}

function transform(raw) {
  return raw
    .filter((item) => item && item.group && item.discovered)
    .map((item) => ({
      group: String(item.group),
      victim: String(item.victim || item.domain || 'Unnamed victim'),
      sector: item.activity && item.activity !== 'Not Found' ? String(item.activity) : '',
      country: item.country ? String(item.country) : '',
      // Victim website: `website` on the PRO API, `domain` on the free v2 API.
      // Carried in feed.json so the org-watch alert Worker can match domains
      // exactly instead of relying on name substrings.
      domain: String(item.website || item.domain || '')
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0],
      discovered: new Date(item.discovered).toISOString(),
      // The PRO API calls the public victim page `permalink`, the free v2 API
      // calls it `url`; both point at www.ransomware.live.
      link: [item.permalink, item.url].find(
        (url) => typeof url === 'string' && url.startsWith('https://www.ransomware.live/'),
      ) || '',
    }))
    .sort((a, b) => new Date(b.discovered) - new Date(a.discovered))
    .slice(0, MAX_ITEMS);
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

main().catch((error) => {
  console.error('Feed generation failed:', error);
  process.exitCode = 1;
});
