// A local stand-in for every upstream (127.0.0.1 only). Routes are chosen by
// the ORIGINAL url the script asked for:
//   routes: [{ match: 'substring of the original url', body, status, hang, repeat }]
// Anything unmatched gets a small, fresh, well-formed RSS feed for that host.
const http = require('node:http');

const benignFeed = (host) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${host}</title>
${[1, 2, 3].map((n) => `<item><title>${host} story ${n}</title><link>https://${host}/story-${n}</link><pubDate>${new Date().toUTCString()}</pubDate><description><![CDATA[<p>Summary ${n} from ${host}.</p>]]></description></item>`).join('\n')}
</channel></rss>`;

function startFixtureServer(routes = []) {
  const requested = [];
  const server = http.createServer(async (req, res) => {
    const original = new URL(req.url, 'http://fixture').searchParams.get('u') || '';
    requested.push(original);
    const route = routes.find((r) => original.includes(r.match));
    if (route?.hang) return;
    if (route) {
      res.writeHead(route.status || 200, { 'Content-Type': route.type || 'application/xml' });
      const piece = Buffer.from(route.body || '');
      for (let i = 0; i < (route.repeat || 1); i += 1) {
        if (res.destroyed) return;
        if (!res.write(piece)) await new Promise((resolve) => res.once('drain', resolve));
      }
      res.end();
      return;
    }
    let host = 'unknown.test';
    try {
      host = new URL(original).hostname;
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(benignFeed(host));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requested,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(done);
        }),
      });
    });
  });
}

module.exports = { startFixtureServer };
