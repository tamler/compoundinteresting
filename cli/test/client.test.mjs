import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { request, MAX_BODY, validateResponse } from '../src/client.mjs';
import { parseCommand } from '../src/commands.mjs';
import { main } from '../src/main.mjs';
import { render, filingLink } from '../src/output.mjs';

const KEY = 'synthetic-secret-never-print';
const ticker = parseCommand(['ticker', 'AAPL']);
const valid = () => ({ data: { entity_id: 'equity:AAPL', symbol: 'AAPL', dimensions: {}, price: null, unknown: { nested: null } }, meta: { generation: 'synthetic', as_of: null } });
const safe = e => !String(e).includes(KEY) && !JSON.stringify(e).includes(KEY);

test('each error preserves status, uses distinct safe codes/messages and makes exactly one request', async () => {
  const cases = [[401, 'auth_required', 3], [402, 'upgrade_required', 4], [429, 'rate_limited', 5], [429, 'quota_exceeded', 5], [400, 'bad_request', 6], [404, 'not_found', 6], [404, 'evidence_not_published', 6], [410, 'retracted', 6], [410, 'gone', 6], [409, 'snapshot_changed', 6], [503, 'apply_in_progress', 6], [503, 'dataset_unavailable', 6], [503, 'snapshot_stale', 6], [500, 'internal', 6], [403, 'forbidden', 6]];
  const messages = new Set();
  for (const [status, code, exit] of cases) {
    let calls = 0;
    await assert.rejects(request(ticker, KEY, { fetcher: async () => { calls++; return Response.json({ error: { code, message: `hostile upstream ${KEY}\u001b[31m`, cause: { request: KEY } } }, { status }); } }), e => {
      assert.equal(e.status, status); assert.equal(e.exit, exit); assert.equal(e.code, code); assert.ok(safe(e)); messages.add(e.message); return true;
    });
    assert.equal(calls, 1);
  }
  assert.equal(messages.size, cases.length);
  for (const code of [KEY, '__proto__', 'stacktrace', null]) {
    await assert.rejects(request(ticker, KEY, { fetcher: async () => Response.json({ error: { code, message: KEY } }, { status: 500 }) }), e => e.code === 'upstream_error' && e.status === 500 && safe(e));
  }
});

test('429 hints are bounded and sanitized; hints on other statuses are ignored', async () => {
  for (const [hint, allowed] of [['12', true], ['86400', true], ['86401', false], ['999999', false], ['-1', false], ['1.5', false], [KEY, false]]) {
    await assert.rejects(request(ticker, KEY, { fetcher: async () => Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': hint } }) }), e => {
      if (allowed) assert.equal(e.hint.retry_after_seconds, Number(hint)); else assert.equal(e.hint, undefined);
      assert.ok(safe(e)); return true;
    });
  }
  const reset = new Date(Date.now() + 60000).toISOString();
  await assert.rejects(request(ticker, KEY, { fetcher: async () => Response.json({ error: { code: 'quota_exceeded', resets_at: reset } }, { status: 429 }) }), e => e.hint.resets_at === reset);
  await assert.rejects(request(ticker, KEY, { fetcher: async () => Response.json({ error: { code: 'internal', resets_at: reset } }, { status: 500, headers: { 'retry-after': '12' } }) }), e => e.hint === undefined);
});

test('invalid JSON, UTF-8, envelope, finite counts and recursive depth reject instead of demo fallback', async () => {
  const malformed = [
    'not JSON', Buffer.from([0xff]), '{}', 'null', '[]',
    JSON.stringify({ data: valid().data, meta: null }),
    JSON.stringify({ data: valid().data, meta: [] }),
    JSON.stringify({ data: valid().data, meta: {}, error: { code: 'not_found' } }),
    JSON.stringify({ data: { ...valid().data, symbol: '' }, meta: {} }),
    JSON.stringify({ data: { ...valid().data, entity_id: 1 }, meta: {} }),
    JSON.stringify({ data: valid().data, meta: { count: -1 } }),
    JSON.stringify({ data: valid().data, meta: { count: 1.5 } }),
    JSON.stringify({ data: valid().data, meta: { matched_count: Number.MAX_SAFE_INTEGER + 1 } }),
    '{"data":{"entity_id":"equity:AAPL","symbol":"AAPL","dimensions":{},"overflow":1e999},"meta":{}}',
  ];
  let depth = null; for (let i = 0; i < 70; i++) depth = { nested: depth };
  malformed.push(JSON.stringify({ data: { ...valid().data, depth }, meta: {} }));
  for (const body of malformed) await assert.rejects(request(ticker, KEY, { fetcher: async () => new Response(body) }), e => e.code === 'invalid_response' && e.exit === 7 && safe(e));
  const body = valid(); assert.deepEqual(await request(ticker, KEY, { fetcher: async () => Response.json(body) }), body);
  assert.deepEqual(await request(parseCommand(['rating', 'AAPL']), KEY, { fetcher: async () => Response.json({ data: null, meta: {} }) }), { data: null, meta: {} });
});

test('route-specific containers, counts and cursors are validated independently', () => {
  const invalid = [
    [['search', 'a'], [{ entity_id: 'equity:AAPL' }]],
    [['screen'], { items: [], matched_count: -1, has_more: false }],
    [['screen'], { items: [], matched_count: 0, has_more: 'false' }],
    [['screen'], { items: [null], matched_count: 1, has_more: false }],
    [['events', 'AAPL'], []],
    [['notices'], { items: [], next_cursor: null, coverage: [] }],
    [['feed', 'insiders'], { items: [], count: 1, matched_count: 1, next_cursor: null }],
    [['feed', 'congress'], { items: [], count: 0, matched_count: 0, next_cursor: 3 }],
    [['feed', 'positioning'], { items: [], count: 0, matched_count: -1, next_cursor: null }],
  ];
  for (const [args, data] of invalid) assert.throws(() => validateResponse(parseCommand(args), { data, meta: {} }), e => e.exit === 7);
});

test('feed event primary-key identity is mandatory even though nullable entity_id is valid', () => {
  for (const kind of ['insiders', 'congress', 'positioning']) {
    const spec = parseCommand(['feed', kind]);
    const page = items => ({ data: { items, count: items.length, matched_count: items.length, next_cursor: null }, meta: {} });
    assert.doesNotThrow(() => validateResponse(spec, page([{ event_id: 'synthetic:1', entity_id: null }])));
    for (const row of [{}, { event_id: null }, { event_id: 42 }, { event_id: '' }]) assert.throws(() => validateResponse(spec, page([row])), e => e.exit === 7, `${kind} ${JSON.stringify(row)}`);
  }
});

test('decoded byte cap applies with missing and false Content-Length; exact bounded body remains valid', async () => {
  const skeleton = JSON.stringify({ data: { ...valid().data, padding: '' }, meta: {} });
  const bounded = JSON.stringify({ data: { ...valid().data, padding: 'a'.repeat(MAX_BODY - Buffer.byteLength(skeleton)) }, meta: {} });
  assert.equal(Buffer.byteLength(bounded), MAX_BODY);
  const accepted = await request(ticker, KEY, { fetcher: async () => new Response(bounded, { headers: { 'content-length': '1' } }) });
  assert.equal(accepted.data.padding.length, MAX_BODY - Buffer.byteLength(skeleton));
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_BODY)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    await assert.rejects(request(ticker, KEY, { fetcher: async () => new Response(body, { headers }) }), e => e.exit === 7);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
  }
});

test('deadline covers stalled headers and body; SIGINT abort returns130 during body and fetch', async () => {
  for (const phase of ['fetch', 'body']) {
    let observed;
    const fetcher = async (url, options) => { observed = options.signal; return phase === 'fetch' ? new Promise(() => {}) : new Response(new ReadableStream()); };
    await assert.rejects(request(ticker, KEY, { fetcher, deadline: 25 }), e => e.code === 'timeout' && e.exit === 6);
    assert.equal(observed.aborted, true);
    const controller = new AbortController();
    const p = request(ticker, KEY, { fetcher, signal: controller.signal, deadline: 500 });
    const rejected = assert.rejects(p, e => e.code === 'cancelled' && e.exit === 130);
    setImmediate(() => controller.abort()); await rejected; assert.equal(observed.aborted, true);
  }
  let calls = 0; const pre = new AbortController(); pre.abort();
  await assert.rejects(request(ticker, KEY, { signal: pre.signal, fetcher: async () => { calls++; } }), e => e.exit === 130);
  assert.equal(calls, 0);
});

test('transport exceptions cannot print headers, request URLs, raw causes or key', async () => {
  await assert.rejects(request(ticker, KEY, { fetcher: async () => { throw new Error(`Authorization: Bearer ${KEY}`, { cause: { token: KEY } }); } }), e => e.code === 'network_error' && e.exit === 6 && safe(e));
  await assert.rejects(request({ ...ticker, url: 'http://api.compoundinterest.ing/v1/composite/AAPL' }, KEY), e => e.exit === 7);
  await assert.rejects(request({ ...ticker, url: 'https://api.compoundinterest.ing.evil.invalid/v1/composite/AAPL' }, KEY), e => e.exit === 7);
  await assert.rejects(request({ ...ticker, url: 'https://user:pass@api.compoundinterest.ing/v1/composite/AAPL' }, KEY), e => e.exit === 7);
});

test('real loopback redirect trap receives no followup request or credential', async t => {
  const targetRequests = []; const sourceRequests = [];
  const target = http.createServer((req, res) => { targetRequests.push({ url: req.url, auth: req.headers.authorization }); res.end('{}'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const source = http.createServer((req, res) => { sourceRequests.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/trap` }); res.end(); });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  t.after(async () => { source.closeAllConnections(); target.closeAllConnections(); await Promise.all([new Promise(r => source.close(r)), new Promise(r => target.close(r))]); });
  await assert.rejects(request(ticker, KEY, { fetcher: (url, options) => fetch(`http://127.0.0.1:${source.address().port}${new URL(url).pathname}`, options) }), e => e.exit === 6 && safe(e));
  assert.deepEqual(sourceRequests, [{ url: '/v1/composite/AAPL', auth: `Bearer ${KEY}` }]);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(targetRequests, []);
});

test('table and JSON outputs preserve ranges/nulls/metadata and neutralize hostile terminal text', () => {
  const data = { items: [{ state: 'activist_target', summary: '\u001b[31m\u202eHOSTILE\r\n', amount_min: 1001, amount_max: 15000, unit: 'USD', price: null, filing_url: 'https://evil.invalid/steal' }], count: 1, coverage: { through: null } };
  const result = { data, meta: { attribution: { text: 'Synthetic source credit', source_record_date: null }, as_of: null } };
  const table = render(result, 'table');
  assert.match(table, /Large-holder signal/); assert.match(table, /1001/); assert.match(table, /15000/); assert.match(table, /USD/); assert.match(table, /price\tnull/);
  assert.match(table, /Synthetic source credit/); assert.match(table, /as_of\tnull/); assert.match(table, /no filing link/);
  assert.doesNotMatch(table, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u);
  const json = render(result, 'json'); assert.deepEqual(JSON.parse(json), result); assert.ok(!json.includes('\u202e'));
  for (const url of ['https://www.sec.gov/Archives/edgar/data/1/a.htm', 'https://disclosures-clerk.house.gov/a', 'https://efdsearch.senate.gov/a']) assert.equal(filingLink(url), url);
  for (const url of ['https://house.gov.evil.invalid/a', 'https://user:secret@www.sec.gov/Archives/edgar/data/1', 'https://www.sec.gov/not-archives', 'javascript:alert(1)', 'https://senate.gov:444/a']) assert.equal(filingLink(url), 'no filing link');
});

test('JSON errors go to stdout, table errors to stderr and a broken output pipe exits cleanly', async () => {
  for (const format of ['json', 'table']) {
    let out = ''; let err = '';
    const exit = await main(['ticker', 'AAPL', '--format', format], { auth: { env: { CI_API_KEY: KEY } }, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } }, fetcher: async () => Response.json({ error: { code: 'retracted', message: KEY } }, { status: 410 }) });
    assert.equal(exit, 6); assert.ok(!(out + err).includes(KEY));
    if (format === 'json') { assert.equal(err, ''); assert.equal(JSON.parse(out).error.code, 'retracted'); } else { assert.equal(out, ''); assert.match(err, /retracted/); }
  }
  const exit = await main(['--help'], { stdout: { write() { throw Object.assign(new Error(KEY), { code: 'EPIPE' }); } } });
  assert.equal(exit, 0);
});
