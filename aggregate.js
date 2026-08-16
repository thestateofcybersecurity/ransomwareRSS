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
// curated list actually uses, not a general XML parser: the list is vetted, a
// feed that drifts into an unparseable shape just drops out of that run, and
// the run only fails when most sources fail at once (a network problem, not a
// feed problem). Zero runtime dependencies; requires Node 18+.

const fs = require('fs/promises');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'dist');
const FEED_URL = 'https://thestateofcybersecurity.github.io/ransomwareRSS/cybersecurity-feed.xml';
const SITE_URL = 'https://www.cybersecurityalphabetsoup.com/news/';
const USER_AGENT = 'AlphabetSoupFeedBot/1.0 (+https://www.cybersecurityalphabetsoup.com/news/)';

const PER_SOURCE_CAP = 8;
const TOTAL_CAP = 100;
const MAX_AGE_DAYS = 7;
const MIN_SOURCES = 8;
const EXCERPT_CHARS = 280;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Decode the entities feeds actually emit, including numeric ones. */
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** First <name>...</name> in a block, CDATA unwrapped, entities decoded. */
function tagText(xml, name) {
  const match = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!match) return '';
  let value = match[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1].trim();
  return decodeEntities(value).trim();
}

/** Strip markup and collapse whitespace for the excerpt. */
function plainText(html) {
  return decodeEntities(html.replace(/<!\[CDATA\[|\]\]>/g, ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(itemXml) {
  const raw = tagText(itemXml, 'description') || tagText(itemXml, 'summary');
  const text = plainText(raw);
  if (text.length <= EXCERPT_CHARS) return text;
  return `${text.slice(0, EXCERPT_CHARS).replace(/\s+\S*$/, '')}…`;
}

function itemLink(itemXml) {
  // RSS: <link>https://…</link>, sometimes CDATA-wrapped (Dark Reading).
  // Atom: <link href="…"/>, preferring rel="alternate" over self links; the
  // text-content lookup skips those because they self-close.
  const rssLink = tagText(itemXml, 'link');
  if (rssLink) return rssLink;
  const links = [...itemXml.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  const preferred =
    links.find((attrs) => /rel=["']alternate["']/.test(attrs)) ||
    links.find((attrs) => !/rel=/.test(attrs));
  const href = preferred && preferred.match(/href=["']([^"']+)["']/);
  return href ? decodeEntities(href[1]) : '';
}

function itemDate(itemXml) {
  for (const name of ['pubDate', 'published', 'updated', 'dc:date']) {
    const value = tagText(itemXml, name);
    if (value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  }
  return '';
}

/** Parse one fetched feed body into normalized items. */
function parseItems(xml, source) {
  const blocks = [...xml.matchAll(/<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi)];
  const items = [];
  for (const [, block] of blocks) {
    const title = plainText(tagText(block, 'title'));
    const link = itemLink(block);
    const date = itemDate(block);
    if (!title || !link.startsWith('http') || !date) continue;
    items.push({
      source: source.name,
      sourceUrl: source.homepage,
      title,
      link,
      date,
      excerpt: excerpt(block),
    });
    if (items.length >= PER_SOURCE_CAP) break;
  }
  return items;
}

async function fetchFeed(source) {
  const response = await fetch(source.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`responded ${response.status}`);
  return parseItems(await response.text(), source);
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
  const { feeds } = JSON.parse(await fs.readFile(path.join(__dirname, 'feeds.json'), 'utf8'));
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
      const reason = result.status === 'rejected' ? result.reason.message : 'no parseable items';
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
    .sort((a, b) => new Date(b.date) - new Date(a.date))
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

main().catch((error) => {
  console.error('Aggregation failed:', error);
  process.exitCode = 1;
});
