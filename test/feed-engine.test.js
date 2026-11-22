// node:test suite for the feed engine. Every upstream is hostile: the
// fixtures in test/fixtures are the proof-of-concept inputs from the
// 2026-10-07 and 2026-11-22 security reviews. No network: the end-to-end
// tests run the real scripts against a local fixture server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const common = require('../lib/common.js');
const ransomware = require('../index.js');
const aggregate = require('../aggregate.js');
const { startFixtureServer } = require('./helpers/fixture-server.js');

const ROOT = path.join(__dirname, '..');
const NOW = Date.now();
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();
const fixture = (name) =>
  fs
    .readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
    .replace(/PUBDATE_1/g, new Date(NOW - 60_000).toUTCString())
    .replace(/ISODATE_1/g, iso(-120_000))
    .replace(/ISODATE_2/g, iso(-180_000))
    .replace(/DATE_(\d)/g, (_, n) => iso(-Number(n) * 1000));
const SOURCE = { name: 'Example Security News', url: 'https://www.example-news.test/feed/', homepage: 'https://www.example-news.test/' };
const ch = (...codes) => String.fromCharCode(...codes);
/** Characters XML 1.0 forbids (plus lone surrogates): none may appear in an output file. */
const XML_ILLEGAL = new RegExp(`[${ch(0)}-${ch(8)}${ch(0xb)}${ch(0xc)}${ch(0xe)}-${ch(0x1f)}${ch(0xfffe)}${ch(0xffff)}]|[${ch(0xd800)}-${ch(0xdbff)}](?![${ch(0xdc00)}-${ch(0xdfff)}])|(?<![${ch(0xd800)}-${ch(0xdbff)}])[${ch(0xdc00)}-${ch(0xdfff)}]`);
const BIDI_OR_ZERO_WIDTH = new RegExp(`[${ch(0x200b)}-${ch(0x200f)}${ch(0x2028)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0xfeff)}]`);
/** Minimal well-formedness check for our own generated documents: tags balance and no raw "<" or "&" in text. */
function assertBalancedXml(xml) {
  assert.doesNotMatch(xml, XML_ILLEGAL, 'no character that XML 1.0 forbids');
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?xml[^?]*\?>|<!DOCTYPE[^>]*>/g;
  let last = 0;
  let match;
  while ((match = tagRe.exec(xml))) {
    const between = xml.slice(last, match.index);
    assert.doesNotMatch(between, /<|&(?!(?:amp|lt|gt|quot|#39);)/, `raw markup in text near: ${between.slice(0, 60)}`);
    last = tagRe.lastIndex;
    if (!match[2]) continue;
    if (match[1]) assert.equal(stack.pop(), match[2], `closing tag ${match[2]}`);
    else if (!match[4]) stack.push(match[2]);
  }
  assert.doesNotMatch(xml.slice(last), /<|&(?!(?:amp|lt|gt|quot|#39);)/);
  assert.deepEqual(stack, [], 'every tag closed');
}

/* ------------------------------ lib/common.js ------------------------------ */

test('httpsUrl: only plain https URLs pass (October rule, re-validated)', () => {
  const rejected = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', `java${ch(9)}script:alert(1)`, `java${ch(10)}script:alert(1)`,
    'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://example.com/x', 'blob:https://example.com/1',
    'http://example.com/', '//example.com/x', '/relative', 'example.com/x', 'httpx://example.com/', 'https//example.com', '',
    'https://user@example.com/', 'https://user:pass@example.com/', 'https://example.com@evil.example/',
    'https://example.com:8443/', 'https://example.com./',
    'https://example.com/ x', ' https://example.com/', `https://example.com/${ch(0)}`, `https://example.com/${ch(10)}https://evil.example/`,
    `https://example.com/${ch(0x202e)}x`, `https://exa${ch(0x200b)}mple.com/`, `https://example.com/${ch(0x85)}`,
    `https://example.com/${'a'.repeat(3000)}`, null, undefined, 42, {}, ['https://example.com/'],
  ];
  for (const value of rejected) assert.equal(common.httpsUrl(value), '', JSON.stringify(value));
  assert.equal(common.httpsUrl('https://Example.COM/a?b=c#d'), 'https://example.com/a?b=c#d');
  assert.equal(common.httpsUrl('https://example.com:443/'), 'https://example.com/', 'default port normalizes away');
  assert.equal(common.httpsUrl('https:\\\\example.com\\x'), 'https://example.com/x', 'backslashes are still an https URL; scope checks decide the host');
});

test('httpsUrl: host and site scoping, including look-alikes', () => {
  const scope = { hosts: ['www.ransomware.live'] };
  assert.equal(common.httpsUrl('https://www.ransomware.live/id/abc', scope), 'https://www.ransomware.live/id/abc');
  for (const value of [
    'https://ransomware.live/id/abc', 'https://www.ransomware.live.evil.example/id', 'https://evil.example/www.ransomware.live/',
    'https://www.ransomware.live@evil.example/', `https://www.ransomware.l${ch(0x456)}ve/id`, 'https://xn--www.ransomware.live/',
    `https://www${ch(0x3002)}ransomware${ch(0x3002)}live${ch(0x3002)}evil.example/`,
  ]) {
    assert.equal(common.httpsUrl(value, scope), '', value);
  }
  const sites = { sites: ['example-news.test'] };
  assert.ok(common.httpsUrl('https://sub.example-news.test/x', sites));
  assert.equal(common.httpsUrl('https://example-news.test.evil.example/x', sites), '');
  assert.equal(common.httpsUrl(`https://www.exampl${ch(0x435)}-news.test/x`, sites), '', 'Cyrillic look-alike becomes a different punycode host');
  assert.equal(common.siteOf('feeds.feedburner.com'), 'feedburner.com');
});

test('cleanText and esc: nothing that breaks XML or disguises text survives', () => {
  const hostile = `a${ch(0, 1, 8, 0xb, 0xc, 0x1f, 0x7f, 0x85)}b${ch(0x202e)}c${ch(0x200b, 0xfeff, 0x2028)}d${ch(0xfffe, 0xffff)}e${ch(0xd800)}f${ch(0xdc00)}g`;
  const cleaned = common.cleanText(hostile);
  assert.doesNotMatch(cleaned, XML_ILLEGAL);
  assert.doesNotMatch(cleaned, BIDI_OR_ZERO_WIDTH);
  assert.equal(cleaned.replace(/ /g, ''), 'abcdefg');
  assert.doesNotMatch(common.esc(hostile), XML_ILLEGAL);
  assert.equal(common.esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(common.cleanText(`ok ${String.fromCodePoint(0x1f600)} emoji`), `ok ${String.fromCodePoint(0x1f600)} emoji`, 'valid surrogate pairs are kept');
  assert.equal(common.cleanText('x'.repeat(5000), 100).length, 100);
  assert.equal(common.cleanText(`${'x'.repeat(99)}${String.fromCodePoint(0x1f600)}`, 100).length, 99, 'never splits a surrogate pair');
  for (const value of [null, undefined, {}, [], true, () => 1, { toString: 1 }]) assert.equal(common.cleanText(value), '');
  assert.equal(common.cleanText(42), '42');
  assert.equal(common.cleanHostname('HTTPS://Sub.Example.com/path?q=1'), 'sub.example.com');
  for (const bad of ['not a hostname', 'a_b.com', 'localhost', '-a.com', 'a..com', `${'a'.repeat(64)}.com`, '<script>.com', 7, null]) assert.equal(common.cleanHostname(bad), '', String(bad));
});

test('fetchText: size cap, deadline, and error status', async () => {
  const server = await startFixtureServer([
    { match: 'big.test', body: 'x'.repeat(64 * 1024), repeat: 64 },
    { match: 'slow.test', hang: true },
    { match: 'error.test', status: 503, body: 'down' },
    { match: 'ok.test', body: 'hello' },
  ]);
  const get = (host, options) => common.fetchText(`${server.url}/fetch?u=${encodeURIComponent(`https://${host}/`)}`, options);
  try {
    assert.equal(await get('ok.test', { maxBytes: 1024 }), 'hello');
    await assert.rejects(get('big.test', { maxBytes: 256 * 1024 }), /larger than 262144 bytes/);
    const started = Date.now();
    await assert.rejects(get('slow.test', { maxBytes: 1024, timeoutMs: 300 }));
    assert.ok(Date.now() - started < 3000, 'gave up at the deadline');
    await assert.rejects(get('error.test', { maxBytes: 1024 }), /responded 503/);
  } finally {
    await server.close();
  }
});

/* -------------------------------- index.js -------------------------------- */

test('index.js: each API record is validated on its own; one bad record cannot abort the run', () => {
  const records = JSON.parse(fixture('api-hostile.json'));
  const items = ransomware.transform(records, NOW);
  const names = items.map((item) => item.victim);
  assert.ok(names.includes('Good Corp'));
  for (const dropped of ['Bad Date Corp', 'Future Corp', 'No Group Corp']) assert.ok(!names.includes(dropped), dropped);
  assert.equal(items.length, 7, JSON.stringify(names));
  for (const item of items) {
    assert.ok(item.link === '' || item.link.startsWith('https://www.ransomware.live/'), item.link);
    assert.match(item.discovered, /^\d{4}-\d\d-\d\dT/);
    assert.ok(item.domain === '' || /^[a-z0-9.-]+$/.test(item.domain), item.domain);
    for (const key of ['group', 'victim', 'sector', 'country']) {
      assert.equal(typeof item[key], 'string');
      assert.doesNotMatch(item[key], XML_ILLEGAL);
      assert.doesNotMatch(item[key], BIDI_OR_ZERO_WIDTH);
    }
  }
  const by = (victim) => items.find((item) => item.victim.includes(victim));
  assert.equal(by('Userinfo').link, '');
  assert.equal(by('Port Corp').link, '');
  assert.equal(by('Port Corp').domain, '');
  assert.equal(by('Data Corp').link, '');
  assert.equal(by('Data Corp').domain, 'sub.datacorp.test');
  assert.equal(by('Bidi').link, '', 'control characters and http are both refused');
  assert.equal(by('onerror').link, '');
  assert.equal(by('onerror').domain, 'evil.example');
  assert.equal(by('12345').sector, '', '"Not Found" sector is blanked');
  assert.equal(by('12345').country, '44');
  assert.deepEqual(ransomware.transform([null, 7, 'x', [], {}, { group: 'g' }, { group: 'g', discovered: {} }], NOW), []);
});

test('index.js: field sizes are bounded and the item count is capped', () => {
  const huge = { group: 'g'.repeat(1e6), victim: 'v'.repeat(3e6), activity: 's'.repeat(1e6), country: 'c'.repeat(1e5), domain: `${'d'.repeat(2e5)}.test`, discovered: iso(), url: `https://www.ransomware.live/${'a'.repeat(5000)}` };
  const [item] = ransomware.transform([huge], NOW);
  assert.deepEqual([item.group.length, item.victim.length, item.sector.length, item.country.length, item.domain, item.link], [80, 200, 80, 60, '', '']);
  const many = Array.from({ length: 400 }, (_, i) => ({ group: 'g', victim: `v${i}`, discovered: iso(-i * 1000) }));
  const items = ransomware.transform(many, NOW);
  assert.equal(items.length, 50);
  assert.equal(items[0].victim, 'v0', 'newest first');
});

test('index.js: generated RSS and HTML stay well-formed and escaped with hostile records', () => {
  const items = ransomware.transform(JSON.parse(fixture('api-hostile.json')), NOW);
  const rss = ransomware.generateRSS(items);
  assertBalancedXml(rss);
  assert.doesNotMatch(rss, /<script|<img|<b>|\]\]>/);
  const html = ransomware.generateHTML(items);
  assert.doesNotMatch(html, XML_ILLEGAL);
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(2\)>|href="(?!https:\/\/|feed\.xml)/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  // Raw items carrying control characters (as if transform were bypassed) still serialize to legal XML.
  assertBalancedXml(ransomware.generateRSS([{ group: `g${ch(1)}`, victim: `v${ch(0xb)}${ch(0xffff)}`, sector: '', country: '', domain: '', discovered: iso(), link: '' }]));
});

/* ------------------------------ aggregate.js ------------------------------ */

test('aggregate.js: RSS and Atom shapes parse as before', () => {
  const rss = aggregate.parseItems(fixture('benign-rss.xml'), SOURCE, NOW);
  assert.deepEqual(rss.map((item) => [item.title, item.link]), [
    ['Patch Tuesday fixes 80 flaws & two zero-days', 'https://www.example-news.test/news/patch-tuesday/'],
    ['CDATA wrapped title', 'https://www.example-news.test/news/cdata-link/'],
  ]);
  assert.equal(rss[0].excerpt, 'Microsoft shipped fixes for 80 flaws, including two that are exploited in the wild.');
  assert.equal(rss[1].excerpt, 'Escaped markup in a plain description.');
  assert.equal(rss[0].source, 'Example Security News');
  assert.equal(rss[0].sourceUrl, 'https://www.example-news.test/');
  const atom = aggregate.parseItems(fixture('benign-atom.xml'), { name: 'Research', url: 'https://research.example-news.test/feed.xml', homepage: 'https://research.example-news.test/' }, NOW);
  assert.deepEqual(atom.map((item) => [item.title, item.link, item.excerpt]), [
    ['Fuzzing a parser & finding 12 bugs', 'https://research.example-news.test/2026/11/fuzzing.html', 'We fuzzed a parser.'],
    ['Second entry', 'https://research.example-news.test/2026/11/second.html', 'Plain summary.'],
  ]);
  const long = `<item><title>Long</title><link>https://www.example-news.test/l</link><pubDate>${new Date(NOW).toUTCString()}</pubDate><description>${'word '.repeat(200)}</description></item>`;
  const [item] = aggregate.parseItems(long, SOURCE, NOW);
  assert.ok(item.excerpt.length <= 281 && item.excerpt.endsWith(ch(0x2026)), 'long excerpts are cut at a word and end with an ellipsis');
});

test('aggregate.js: of 19 hostile links only the one plain https link on the publisher site is published', () => {
  const items = aggregate.parseItems(fixture('hostile-links.xml'), { ...SOURCE, name: 'Hostile' }, NOW);
  assert.deepEqual(items.map((item) => item.title), ['the one good link']);
  assert.equal(items[0].link, 'https://www.example-news.test/news/good/');
  // linkHosts widens the scope for exactly the listed host, nothing else.
  const wider = aggregate.parseItems(fixture('hostile-links.xml'), { ...SOURCE, linkHosts: ['evil.example'] }, NOW);
  assert.deepEqual(wider.map((item) => item.link).sort(), ['https://evil.example/news', 'https://evil.example/phish', 'https://www.example-news.test/news/good/']);
});

test('aggregate.js: CDATA breakouts and markup never survive as markup', () => {
  const items = aggregate.parseItems(fixture('hostile-markup.xml'), SOURCE, NOW);
  assert.equal(items.length, 5);
  for (const item of items) {
    assert.doesNotMatch(item.title + item.excerpt, /<script|<img[^>]*>|<svg[^>]*>|\]\]>|<!\[CDATA\[/i, item.title);
  }
  const rss = aggregate.generateRSS(items);
  assertBalancedXml(rss);
  assert.doesNotMatch(rss, /<script|<img|<svg|\]\]>/i);
  assert.match(items[4].title, /Attribute " breakout ' title/);
  assert.match(rss, /Attribute &quot; breakout &#39; title/);
  const opml = aggregate.generateOPML([{ name: 'A" onload="x', category: 'C"><script>', url: 'https://a.test/"><x', homepage: "https://a.test/'" }]);
  assertBalancedXml(opml);
  assert.doesNotMatch(opml, /<script|<x/);
});

test('aggregate.js: hostile numeric entities cannot break the output or drop the source', () => {
  const items = aggregate.parseItems(fixture('hostile-entities.xml'), SOURCE, NOW);
  assert.equal(items.length, 4, 'out-of-range references no longer throw the whole feed away');
  for (const item of items) {
    assert.doesNotMatch(item.title + item.excerpt, XML_ILLEGAL);
    assert.doesNotMatch(item.title + item.excerpt, BIDI_OR_ZERO_WIDTH);
  }
  assertBalancedXml(aggregate.generateRSS(items));
  assert.equal(aggregate.decodeEntities('&#x110000;&#99999999;&#xD800;'), ch(0xfffd).repeat(3));
  assert.equal(aggregate.decodeEntities('&amp;lt; &lt; &#60; &#x3c; &unknown;'), '&lt; < < < &unknown;', 'single pass, no double decoding here');
});

test('aggregate.js: parsing is linear on every hostile shape (ReDoS)', () => {
  const kib = 1024;
  const date = new Date(NOW).toUTCString();
  const shapes = {
    'unclosed <item> flood': '<item>'.repeat((1024 * kib) / 6),
    'unclosed <entry> flood': '<entry '.repeat((1024 * kib) / 7),
    'item with unclosed <title flood': `<item>${'<title'.repeat(150000)}</item>`,
    'item with unclosed <link flood': `<item><title>t</title>${'<link '.repeat(150000)}</item>`,
    'description of escaped "<" only': `<item><title>t</title><link>https://www.example-news.test/x</link><pubDate>${date}</pubDate><description>${'&lt;'.repeat(250000)}</description></item>`,
    'description of raw "<" only': `<item><title>t</title><link>https://www.example-news.test/x</link><pubDate>${date}</pubDate><description><![CDATA[${'<'.repeat(900000)}]]></description></item>`,
    'title of nested CDATA markers': `<item><title>${'<![CDATA['.repeat(100000)}</title></item>`,
    'whitespace flood in a field': `<item><title>${' '.repeat(900000)}x</title><link>https://www.example-news.test/x</link><pubDate>${date}</pubDate></item>`,
    'entity flood': `<item><title>${'&#x41;'.repeat(150000)}</title><link>https://www.example-news.test/x</link><pubDate>${date}</pubDate></item>`,
    'ampersand flood': `<item><title>${'&'.repeat(900000)}</title><link>https://www.example-news.test/x</link><pubDate>${date}</pubDate></item>`,
    '200,000 tiny complete items': '<item><title>t</title></item>'.repeat(200000),
    'href attribute flood': `<entry><title>t</title><link ${'href='.repeat(180000)}/></entry>`,
  };
  for (const [name, xml] of Object.entries(shapes)) {
    const started = performance.now();
    const items = aggregate.parseItems(xml, SOURCE, NOW);
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${name}: ${ms.toFixed(0)} ms for ${(xml.length / kib).toFixed(0)} KiB`);
    assert.ok(items.length <= 8);
    for (const item of items) assert.ok(item.title.length <= 300 && item.excerpt.length <= 281);
  }
});

test('aggregate.js: feeds.json passes validation, and bad entries fail loudly', () => {
  const { feeds } = JSON.parse(fs.readFileSync(path.join(ROOT, 'feeds.json'), 'utf8'));
  assert.equal(aggregate.validateFeeds(feeds), feeds);
  assert.ok(feeds.filter((feed) => feed.aggregate !== false).length >= 8, 'enough sources to publish');
  const good = { name: 'A', category: 'News', url: 'https://a.test/feed', homepage: 'https://a.test/' };
  for (const bad of [
    [], null, [null], [{ ...good, url: 'http://a.test/feed' }], [{ ...good, url: 'javascript:alert(1)' }], [{ ...good, url: 'file:///etc/passwd' }],
    [{ ...good, homepage: 'https://user:pw@a.test/' }], [{ ...good, name: '' }], [{ ...good, category: 7 }], [good, good],
    [{ ...good, linkHosts: 'evil.example' }], [{ ...good, linkHosts: ['Evil.Example/x'] }], [{ ...good, blurb: 'x'.repeat(501) }],
  ]) {
    assert.throws(() => aggregate.validateFeeds(bad), /feeds\.json/, JSON.stringify(bad).slice(0, 80));
  }
});

/* ------------------------------- end to end ------------------------------- */

function runScript(script, fixtureUrl, outDir, limitMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers', 'redirect-fetch.cjs'), path.join(ROOT, script)], {
      cwd: ROOT,
      env: { ...process.env, RANSOMWARE_LIVE_API_KEY: '', FIXTURE_URL: fixtureUrl, FEED_OUT_DIR: outDir, FEED_FETCH_TIMEOUT_MS: '3000' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, seconds: (Date.now() - started) / 1000 });
    });
  });
}

test('end to end: hostile API and hostile feeds still produce complete, well-formed, bounded output', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-engine-test-'));
  const server = await startFixtureServer([
    { match: 'ransomware.live', type: 'application/json', body: fixture('api-hostile.json') },
    { match: 'bleepingcomputer.com', body: '<item>', repeat: (4 * 1024 * 1024) / 6 },
    { match: 'TheHackersNews', body: 'x'.repeat(1024 * 1024), repeat: 64 },
    { match: 'darkreading.com', hang: true },
    { match: 'securityweek.com', body: fixture('hostile-entities.xml').replace(/www\.example-news\.test/g, 'www.securityweek.com') },
    { match: 'therecord.media', body: fixture('hostile-links.xml').replace(/www\.example-news\.test/g, 'therecord.media') },
    { match: 'krebsonsecurity.com', body: fixture('hostile-markup.xml').replace(/www\.example-news\.test/g, 'krebsonsecurity.com') },
  ]);
  try {
    const first = await runScript('index.js', server.url, outDir);
    assert.equal(first.code, 0, first.out);
    const feed = JSON.parse(fs.readFileSync(path.join(outDir, 'feed.json'), 'utf8'));
    assert.equal(feed.items.length, 7);
    assert.ok(feed.items.every((item) => item.link === '' || item.link.startsWith('https://www.ransomware.live/')));
    assertBalancedXml(fs.readFileSync(path.join(outDir, 'feed.xml'), 'utf8'));
    assert.ok(fs.statSync(path.join(outDir, 'feed.json')).size < 64 * 1024);

    const second = await runScript('aggregate.js', server.url, outDir);
    assert.equal(second.code, 0, second.out);
    assert.ok(second.seconds < 15, `aggregate.js took ${second.seconds} s with a hung source and two bombs`);
    assert.match(second.out, /Skipping BleepingComputer: no parseable items/);
    assert.match(second.out, /Skipping The Hacker News: response larger than 5242880 bytes/);
    assert.match(second.out, /Skipping Dark Reading/);
    const agg = JSON.parse(fs.readFileSync(path.join(outDir, 'cybersecurity-feed.json'), 'utf8'));
    const hosts = new Set(agg.items.map((item) => new URL(item.link).hostname));
    assert.ok(!hosts.has('evil.example'));
    assert.ok(agg.items.every((item) => item.link.startsWith('https://') && !/[@\s]/.test(item.link)));
    assert.deepEqual(agg.items.filter((item) => item.source === 'The Record').map((item) => item.title), ['the one good link']);
    for (const name of ['cybersecurity-feed.xml', 'feeds.opml']) assertBalancedXml(fs.readFileSync(path.join(outDir, name), 'utf8'));
    for (const name of ['feed.json', 'cybersecurity-feed.json', 'feeds.json']) {
      const text = fs.readFileSync(path.join(outDir, name), 'utf8');
      assert.doesNotMatch(text, /\\u00(0[0-8bcef]|1[0-9a-f])|\\u202e|\\ufffe/i, `${name}: no control characters`);
    }
    assert.deepEqual(fs.readdirSync(outDir).sort(), ['cybersecurity-feed.json', 'cybersecurity-feed.xml', 'feed.json', 'feed.xml', 'feeds.json', 'feeds.opml', 'index.html']);
  } finally {
    await server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('end to end: an API that never answers fails the run at the deadline instead of hanging', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-engine-test-'));
  const server = await startFixtureServer([{ match: 'ransomware.live', hang: true }]);
  try {
    const result = await runScript('index.js', server.url, outDir, 45000);
    assert.equal(result.code, 1);
    assert.ok(result.seconds < 15, `gave up after ${result.seconds} s`);
    assert.ok(!fs.existsSync(path.join(outDir, 'feed.json')), 'nothing is published over the last good feed');
  } finally {
    await server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

/* -------------------------------- workflow -------------------------------- */

test('workflows: SHA-pinned actions, no default token permissions, bounded jobs, no interpolation in run steps', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.includes('update-feed.yml'));
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, name);
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name}: ${ref} must be pinned to a full commit SHA`);
    assert.match(text, /^permissions: \{\}$/m, `${name}: top-level permissions must be empty`);
    assert.match(text, /^\s+timeout-minutes: \d+$/m, `${name}: every job needs a timeout`);
    assert.doesNotMatch(text, /pull_request_target/, name);
    const runBlocks = [...text.matchAll(/^\s*run:\s*(.*(?:\n\s{10,}.*)*)/gm)].map((m) => m[1]);
    for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/, `${name}: no expression interpolation inside run steps`);
    assert.match(text, /persist-credentials: false/, `${name}: checkout must not leave the token on disk`);
  }
  const update = fs.readFileSync(path.join(dir, 'update-feed.yml'), 'utf8');
  assert.equal((update.match(/secrets\.RANSOMWARE_LIVE_API_KEY/g) || []).length, 1, 'the API key is exposed to exactly one step');
  assert.match(update, /^concurrency:/m);
});
