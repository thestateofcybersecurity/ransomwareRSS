// Merges the curated feeds in feeds.json into one subscribable feed:
//
//   dist/cybersecurity-feed.xml   RSS 2.0, the "one feed" people subscribe to
//   dist/cybersecurity-feed.json  same items for the Alphabet Soup /news/ page
//   dist/feeds.opml               the directory, importable into any reader
//   dist/feeds.json               the directory as JSON for the /news/ page
//
// Aggregation etiquette: items carry title, link, a short plain-text excerpt,
// and a <source> element crediting the publisher; readers click through.
//
// Parsing is a small forgiving extractor for the RSS 2.0 / Atom shapes the
// curated list actually uses, not a general XML parser. Every feed is treated
// as hostile input all the same (2026-11-22 pentest):
//   - each download has a deadline and a hard size cap
//   - the extractor is a linear scanner (indexOf, no backtracking regex), so
//     no document shape can make it slow
//   - text is stripped of control and bidi-override characters and bounded
//   - a headline link is only published when it is a plain https URL on the
//     publisher's own site (or a host listed in that feed's "linkHosts")
// A feed that drifts into an unparseable shape just drops out of that run,
// and the run only fails when most sources fail at once (a network problem,
// not a feed problem). Zero runtime dependencies; requires Node 18+.

const fs = require('fs/promises');
const path = require('path');
const { FEED_MAX_BYTES, cleanText, esc, fetchText, httpsUrl, siteOf } = require('./lib/common.js');

const OUT_DIR = process.env.FEED_OUT_DIR || path.join(__dirname, 'dist');
const FEEDS_FILE = path.join(__dirname, 'feeds.json');
const FEED_URL = 'https://thestateofcybersecurity.github.io/ransomwareRSS/cybersecurity-feed.xml';
const SITE_URL = 'https://www.cybersecurityalphabetsoup.com/news/';
const USER_AGENT = 'AlphabetSoupFeedBot/1.0 (+https://www.cybersecurityalphabetsoup.com/news/)';

const PER_SOURCE_CAP = 8;
const TOTAL_CAP = 100;
const MAX_AGE_DAYS = 7;
const MIN_SOURCES = 8;
const EXCERPT_CHARS = 280;
const TITLE_CHARS = 300;
/** Scanner bounds: blocks looked at per feed, and characters used from each. */
const MAX_BLOCKS = 200;
const MAX_BLOCK_CHARS = 200_000;
const MAX_FIELD_CHARS = 20_000;
const MAX_FEEDS = 200;
const MAX_FUTURE_MS = 86_400_000;

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' };

/**
 * Decode the entities feeds actually emit, including numeric ones, in one
 * pass. A numeric reference that is not a valid Unicode scalar value becomes
 * U+FFFD instead of throwing; control characters are removed later by
 * cleanText.
 */
function decodeEntities(text) {
  return text.replace(/&(?:#x([0-9a-fA-F]{1,8})|#(\d{1,8})|(lt|gt|quot|apos|nbsp|amp));/g, (match, hex, dec, name) => {
    if (name) return NAMED_ENTITIES[name];
    const code = hex ? parseInt(hex, 16) : Number(dec);
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return String.fromCharCode(0xfffd);
    return String.fromCodePoint(code);
  });
}

/**
 * First <name ...>...</name> in a block, CDATA unwrapped, entities decoded.
 * `lower` is the lowercased block, so tag names match case-insensitively
 * without a regex. Linear: indexOf only.
 */
function tagText(block, lower, name) {
  const needle = `<${name}`;
  let from = 0;
  for (;;) {
    const open = lower.indexOf(needle, from);
    if (open === -1) return '';
    const after = lower.charCodeAt(open + needle.length);
    // The tag name must end here: ">", "/", or whitespace.
    if (after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13) {
      const start = lower.indexOf('>', open + needle.length);
      if (start === -1) return '';
      if (lower.charCodeAt(start - 1) === 47) {
        from = start + 1; // self-closing, no text content
        continue;
      }
      const end = lower.indexOf(`</${name}>`, start + 1);
      if (end === -1) return '';
      let value = block.slice(start + 1, Math.min(end, start + 1 + MAX_FIELD_CHARS)).trim();
      if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) value = value.slice(9, -3).trim();
      return decodeEntities(value).trim();
    }
    from = open + needle.length;
  }
}

/** Remove <...> runs in one linear pass; an unclosed "<" drops the rest of the text. */
function stripTags(text) {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('<', cursor);
    if (open === -1) return out + text.slice(cursor);
    out += `${text.slice(cursor, open)} `;
    const close = text.indexOf('>', open + 1);
    if (close === -1) return out;
    cursor = close + 1;
  }
}

/** Strip markup, decode entities once more (HTML inside CDATA), clean, and bound. */
function plainText(html, max) {
  const bounded = html.length > MAX_FIELD_CHARS ? html.slice(0, MAX_FIELD_CHARS) : html;
  const withoutCdata = bounded.split('<![CDATA[').join('').split(']]>').join('');
  return cleanText(stripTags(decodeEntities(withoutCdata)), max);
}

function excerpt(block, lower) {
  const raw = tagText(block, lower, 'description') || tagText(block, lower, 'summary');
  const text = plainText(raw, EXCERPT_CHARS + 200);
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}\u2026`;
}

/** Attribute value from the inside of a start tag (double or single quoted). */
function attribute(attrs, name) {
  const lower = attrs.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(`${name}=`, from);
    if (at === -1) return '';
    const before = at === 0 ? 32 : lower.charCodeAt(at - 1);
    const quote = attrs.charAt(at + name.length + 1);
    if ((before === 32 || before === 9 || before === 10 || before === 13) && (quote === '"' || quote === "'")) {
      const end = attrs.indexOf(quote, at + name.length + 2);
      return end === -1 ? '' : attrs.slice(at + name.length + 2, end);
    }
    from = at + name.length + 1;
  }
}

function itemLink(block, lower) {
  // RSS: <link>https://...</link>, sometimes CDATA-wrapped (Dark Reading).
  // Atom: <link href="..."/>, preferring rel="alternate" over self links; the
  // text-content lookup skips those because they self-close.
  const rssLink = tagText(block, lower, 'link');
  if (rssLink) return rssLink;
  let fallback = '';
  let from = 0;
  for (let seen = 0; seen < 20; seen += 1) {
    const open = lower.indexOf('<link', from);
    if (open === -1) break;
    const close = lower.indexOf('>', open + 5);
    if (close === -1) break;
    from = close + 1;
    const attrs = block.slice(open + 5, close);
    const href = attribute(attrs, 'href');
    if (!href) continue;
    const rel = attribute(attrs, 'rel').toLowerCase();
    if (rel === 'alternate') return decodeEntities(href);
    if (!rel && !fallback) fallback = decodeEntities(href);
  }
  return fallback;
}

function itemDate(block, lower, now = Date.now()) {
  for (const name of ['pubdate', 'published', 'updated', 'dc:date']) {
    const value = tagText(block, lower, name);
    if (!value || value.length > 100) continue;
    const when = Date.parse(value);
    if (Number.isFinite(when) && when <= now + MAX_FUTURE_MS) return new Date(when).toISOString();
  }
  return '';
}

/**
 * Iterator over "<item" / "<entry" start tags (the name must end at ">" or
 * whitespace). The position of the next candidate of each kind is cached, so
 * a document with thousands of one kind and none of the other is still
 * scanned once, not once per block.
 */
function blockStarts(lower) {
  const next = { item: -2, entry: -2 }; // -2: not searched yet, -1: none left
  const find = (name, from) => {
    if (next[name] === -1 || next[name] >= from) return next[name];
    let at = from;
    for (;;) {
      const open = lower.indexOf(`<${name}`, at);
      if (open === -1) return (next[name] = -1);
      const after = lower.charCodeAt(open + name.length + 1);
      if (after === 62 || after === 32 || after === 9 || after === 10 || after === 13) return (next[name] = open);
      at = open + name.length + 1;
    }
  };
  return (from) => {
    const item = find('item', from);
    const entry = find('entry', from);
    if (item === -1 && entry === -1) return null;
    if (item !== -1 && (entry === -1 || item < entry)) return { open: item, name: 'item' };
    return { open: entry, name: 'entry' };
  };
}

/** Hosts and sites a source's headlines may link to. */
function linkScope(source) {
  const sites = [];
  for (const value of [source.homepage, source.url]) {
    const url = httpsUrl(value);
    if (url) sites.push(siteOf(new URL(url).hostname));
  }
  const hosts = Array.isArray(source.linkHosts) ? source.linkHosts.filter((host) => typeof host === 'string').map((host) => host.toLowerCase()) : [];
  return { sites, hosts };
}

/** Parse one fetched feed body into normalized items. Linear in the size of `xml`. */
function parseItems(xml, source, now = Date.now()) {
  const text = String(xml ?? '');
  const lower = text.toLowerCase();
  const scope = linkScope(source);
  const sourceName = cleanText(source.name, 100);
  const sourceUrl = httpsUrl(source.homepage);
  const items = [];
  let offSite = 0;
  let cursor = 0;
  const nextBlockStart = blockStarts(lower);
  for (let seen = 0; seen < MAX_BLOCKS && items.length < PER_SOURCE_CAP; seen += 1) {
    const start = nextBlockStart(cursor);
    if (!start) break;
    const closeTag = `</${start.name}>`;
    const close = lower.indexOf(closeTag, start.open);
    if (close === -1) break; // nothing after this point is a complete block
    cursor = close + closeTag.length;
    const end = Math.min(close, start.open + MAX_BLOCK_CHARS);
    const block = text.slice(start.open, end);
    const blockLower = lower.slice(start.open, end);
    const title = plainText(tagText(block, blockLower, 'title'), TITLE_CHARS);
    const rawLink = itemLink(block, blockLower).trim();
    const link = httpsUrl(rawLink, scope);
    const date = itemDate(block, blockLower, now);
    if (!link && httpsUrl(rawLink)) offSite += 1;
    if (!title || !link || !date) continue;
    items.push({ source: sourceName, sourceUrl, title, link, date, excerpt: excerpt(block, blockLower) });
  }
  if (offSite > 0) console.warn(`${sourceName}: dropped ${offSite} item(s) whose link is not on the publisher's site`);
  return items;
}

async function fetchFeed(source) {
  const url = httpsUrl(source.url);
  if (!url) throw new Error('feed url is not a plain https URL');
  const xml = await fetchText(url, { headers: { 'User-Agent': USER_AGENT }, maxBytes: FEED_MAX_BYTES });
  return parseItems(xml, source);
}

/**
 * feeds.json is first-party configuration, so a bad entry fails the run
 * loudly instead of being skipped: every feed needs a name, a category, and
 * https `url` and `homepage` values; names and urls must be unique.
 */
function validateFeeds(feeds) {
  if (!Array.isArray(feeds) || feeds.length === 0 || feeds.length > MAX_FEEDS) throw new Error('feeds.json: "feeds" must be a non-empty array');
  const names = new Set();
  const urls = new Set();
  feeds.forEach((feed, index) => {
    const where = `feeds.json entry ${index + 1}`;
    if (!feed || typeof feed !== 'object') throw new Error(`${where}: not an object`);
    for (const key of ['name', 'category']) {
      if (typeof feed[key] !== 'string' || !cleanText(feed[key], 100) || feed[key].length > 100) throw new Error(`${where}: bad "${key}"`);
    }
    for (const key of ['url', 'homepage']) {
      if (!httpsUrl(feed[key])) throw new Error(`${where} (${feed.name}): "${key}" must be a plain https URL`);
    }
    if (feed.blurb !== undefined && (typeof feed.blurb !== 'string' || feed.blurb.length > 500)) throw new Error(`${where} (${feed.name}): bad "blurb"`);
    if (feed.linkHosts !== undefined && !(Array.isArray(feed.linkHosts) && feed.linkHosts.every((host) => typeof host === 'string' && /^[a-z0-9.-]+$/.test(host)))) {
      throw new Error(`${where} (${feed.name}): "linkHosts" must be a list of lowercase hostnames`);
    }
    if (names.has(feed.name) || urls.has(feed.url)) throw new Error(`${where} (${feed.name}): duplicate name or url`);
    names.add(feed.name);
    urls.add(feed.url);
  });
  return feeds;
}

function generateRSS(items) {
  const rssItems = items
    .map(
      (item) => `    <item>
      <title>${esc(item.title)}</title>
      <link>${esc(item.link)}</link>
      <guid isPermaLink="false">${esc(item.link)}</guid>
      <pubDate>${new Date(item.date).toUTCString()}</pubDate>
      <source url="${esc(item.sourceUrl)}">${esc(item.source)}</source>
      <description>${esc(item.excerpt ? `${item.excerpt} (via ${item.source})` : `via ${item.source}`)}</description>
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Cybersecurity Alphabet Soup: Security News</title>
    <description>One feed for cybersecurity news: headlines from ${MIN_SOURCES}+ trusted newsrooms, research teams, and practitioner blogs, merged hourly. Full articles at the original publishers.</description>
    <link>${esc(SITE_URL)}</link>
    <atom:link href="${esc(FEED_URL)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>60</ttl>
${rssItems}
  </channel>
</rss>
`;
}

function generateOPML(feeds) {
  const categories = [...new Set(feeds.map((feed) => feed.category))];
  const outlines = categories
    .map((category) => {
      const rows = feeds
        .filter((feed) => feed.category === category)
        .map(
          (feed) =>
            `      <outline type="rss" text="${esc(feed.name)}" title="${esc(feed.name)}" xmlUrl="${esc(feed.url)}" htmlUrl="${esc(feed.homepage)}"/>`,
        )
        .join('\n');
      return `    <outline text="${esc(category)}" title="${esc(category)}">\n${rows}\n    </outline>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Cybersecurity Alphabet Soup: recommended security feeds</title>
    <ownerName>Cybersecurity Alphabet Soup</ownerName>
    <docs>http://opml.org/spec2.opml</docs>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

async function main() {
  const { feeds } = JSON.parse(await fs.readFile(FEEDS_FILE, 'utf8'));
  validateFeeds(feeds);
  const sources = feeds.filter((feed) => feed.aggregate !== false);

  const results = await Promise.allSettled(sources.map((source) => fetchFeed(source)));
  const sourceStatus = [];
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  let items = [];
  results.forEach((result, index) => {
    const name = sources[index].name;
    if (result.status === 'fulfilled' && result.value.length > 0) {
      sourceStatus.push({ name, ok: true, count: result.value.length });
      items.push(...result.value);
    } else {
      const reason = result.status === 'rejected' ? cleanText(result.reason?.message, 200) : 'no parseable items';
      console.warn(`Skipping ${name}: ${reason}`);
      sourceStatus.push({ name, ok: false, count: 0 });
    }
  });

  const okCount = sourceStatus.filter((status) => status.ok).length;
  if (okCount < MIN_SOURCES) {
    throw new Error(`Only ${okCount} sources succeeded (need ${MIN_SOURCES}); not publishing`);
  }

  items = items
    .filter((item) => Date.parse(item.date) >= cutoff)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, TOTAL_CAP);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'cybersecurity-feed.xml'), generateRSS(items));
  await fs.writeFile(
    path.join(OUT_DIR, 'cybersecurity-feed.json'),
    JSON.stringify({ updated: new Date().toISOString(), sources: sourceStatus, items }, null, 2),
  );
  await fs.writeFile(path.join(OUT_DIR, 'feeds.opml'), generateOPML(feeds));
  await fs.writeFile(
    path.join(OUT_DIR, 'feeds.json'),
    JSON.stringify({ updated: new Date().toISOString(), feeds }, null, 2),
  );

  console.log(`Aggregated ${items.length} items from ${okCount}/${sources.length} sources`);
}

module.exports = { decodeEntities, excerpt, fetchFeed, generateOPML, generateRSS, itemLink, linkScope, parseItems, plainText, stripTags, tagText, validateFeeds };

if (require.main === module) {
  main().catch((error) => {
    console.error('Aggregation failed:', error?.message || error);
    process.exitCode = 1;
  });
}
