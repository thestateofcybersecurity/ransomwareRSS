// Test preload (node --require): send every fetch() the script makes to the
// local fixture server named by FIXTURE_URL, with the original URL in the
// query string. The scripts under test are not modified.
const FIXTURE = process.env.FIXTURE_URL;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  return realFetch(`${FIXTURE}/fetch?u=${encodeURIComponent(url)}`, init);
};
