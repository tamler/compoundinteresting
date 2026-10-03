import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/main.mjs';
import { parseCommand, continuation, ORIGIN } from '../src/commands.mjs';

// Synthetic envelopes model edge/src/router.ts, consensus.ts, events.ts and feed.ts.
// They are transport fixtures, never proof of live publication or customer rights.
export function envelope(command) {
  const entity = { entity_id: 'equity:AAPL', symbol: 'AAPL', dimensions: {}, price: null };
  const data = command === 'catalog' ? { routes: [{ path: '/v1/search' }], tools: [{ name: 'search' }], api_base: ORIGIN, mcp_endpoint: `${ORIGIN}/mcp` }
    : command === 'search' ? [{ entity_id: 'equity:AAPL', symbol: 'AAPL', name: 'Synthetic company' }]
    : command === 'screen' ? { items: [entity], matched_count: 1, has_more: false }
    : command === 'events' ? { items: [{ entity_id: 'equity:AAPL', event_type: null, source: null, occurred_at: null, summary: null }] }
    : command === 'notices' ? { items: [], next_cursor: null, coverage: { through: null } }
    : command.startsWith('feed ') ? { items: [{ event_id: 'synthetic:1', entity_id: null }], next_cursor: null, count: 1, matched_count: 1 }
    : command === 'rating' ? null : command === 'evidence' ? { entity_id: 'equity:AAPL', sources: [] } : entity;
  return { data, meta: { generation: 'synthetic-test-generation', as_of: null, extension: { source: 'synthetic' } } };
}

export async function execute(args, extra = {}) {
  let out = ''; let err = ''; const ledger = [];
  const defaultAuth = { env: { CI_API_KEY: 'synthetic-test-key' } };
  const exit = await main(args, {
    auth: defaultAuth,
    stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } },
    fetcher: async (url, options) => {
      ledger.push({ url, options });
      return Response.json(envelope(parseCommand(args).command));
    }, ...extra,
  });
  return { exit, out, err, ledger };
}

const matrix = [
  [['catalog'], '/v1/catalog', true],
  [['demo'], '/v1/demo/composite', true],
  [['search', 'Research & data'], '/v1/search?q=Research+%26+data'],
  [['ticker', 'brk.b'], '/v1/composite/BRK.B'],
  [['consensus', 'aapl'], '/v1/consensus?ticker=AAPL'],
  [['screen'], '/v1/screen?limit=10'],
  [['feed', 'insiders'], '/v1/feed/insiders?limit=20'],
  [['feed', 'congress'], '/v1/feed/congress?limit=20'],
  [['feed', 'positioning'], '/v1/feed/positioning?limit=20'],
  [['events', 'aapl'], '/v1/events?entity_id=equity%3AAAPL&limit=30'],
  [['notices'], '/v1/form-144/filings?limit=20'],
  [['evidence', 'aapl'], '/v1/evidence/AAPL'],
  [['rating', 'aapl'], '/v1/house-rating/AAPL'],
];
for (const [args, suffix, keyless = false] of matrix) test(`one explicit GET: ${args.join(' ')}`, async () => {
  const result = await execute([...args, '--format', 'json']);
  assert.equal(result.exit, 0, result.out || result.err);
  assert.equal(result.ledger.length, 1);
  assert.equal(result.ledger[0].url, ORIGIN + suffix);
  const opts = result.ledger[0].options;
  assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
  assert.deepEqual(opts.headers, { Accept: 'application/json', ...(!keyless ? { Authorization: 'Bearer synthetic-test-key' } : {}) });
  const body = JSON.parse(result.out);
  assert.deepEqual(body.data, envelope(args.join(' ').startsWith('feed') ? args.join(' ') : args[0]).data);
  assert.deepEqual(body.meta, envelope(args[0]).meta);
  assert.equal(body.client.schema, 1); assert.match(body.client.received_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.err, ''); assert.ok(!result.out.includes('synthetic-test-key'));
});

test('all accepted filters have exact query names, encoding, numeric units and limits', async () => {
  const cases = [
    [['screen', '--sector', 'Health & Care', '--rating', 'hold', '--state', 'activist_target', '--min-confidence', '.5', '--min-completeness', '0.25', '--flagged', '--sort', 'house_rating_confidence', '--order', 'asc', '--limit', '500'], '/v1/screen?flagged=1&limit=500&min_completeness=0.25&min_confidence=0.5&order=asc&rating=hold&sector=Health+%26+Care&sort=house_rating_confidence&state=activist_target'],
    [['feed', 'insiders', '--ticker', 'brk.b', '--since', '2024-02-29', '--limit', '200'], '/v1/feed/insiders?entity_id=equity%3ABRK.B&limit=200&since=2024-02-29'],
    [['feed', 'congress', '--entity', 'equity:brk.b', '--limit', '1'], '/v1/feed/congress?entity_id=equity%3ABRK.B&limit=1'],
    [['feed', 'positioning', '--entity', 'fut:GC', '--limit', '200'], '/v1/feed/positioning?entity_id=fut%3AGC&limit=200'],
    [['events', 'aapl', '--source', 'ctgov', '--type', 'new_source_1', '--limit', '200'], '/v1/events?entity_id=equity%3AAAPL&limit=200&source=ctgov&type=new_source_1'],
    [['notices', '--ticker', 'brk.b', '--since', '2026-01-01', '--min-value', '123.45', '--limit', '100'], '/v1/form-144/filings?limit=100&min_value=123.45&since=2026-01-01&ticker=BRK.B'],
  ];
  for (const [args, suffix] of cases) {
    const result = await execute([...args, '--format', 'json']);
    assert.equal(result.exit, 0, result.out); assert.equal(result.ledger.length, 1);
    assert.equal(result.ledger[0].url, ORIGIN + suffix);
  }
});

const negatives = [
  ['ownership', 'AAPL'], ['form-d'], ['member-history'], ['bulk'], ['write'], ['ai'],
  ['ticker'], ['ticker', 'AAPL', 'extra'], ['ticker', 'https://evil.invalid'], ['ticker', 'ABCDEFGHI'], ['ticker', 'A..B'], ['ticker', 'A/B'],
  ['search', ''], ['search', 'a'.repeat(257)], ['search', '\u001b[31m'], ['search', '\u202etext'],
  ['screen', '--limit', '0'], ['screen', '--limit', '501'], ['screen', '--limit', '1.5'], ['screen', '--limit', '1e2'],
  ['screen', '--limit', 'NaN'], ['screen', '--limit', 'Infinity'], ['screen', '--limit', '10', '--limit', '10'],
  ['screen', '--state', 'strong_bull'], ['screen', '--sort', 'score'], ['screen', '--rating', 'strong_buy'], ['screen', '--order', 'up'],
  ['screen', '--min-confidence', '1.1'], ['screen', '--min-completeness', '-.1'], ['screen', '--sector', '  '],
  ['screen', '--url', 'https://evil.invalid'], ['demo', '--key', 'secret'], ['demo', '--ticker', 'AAPL'], ['screen', '--all'],
  ['feed', 'congress', '--limit', '21'], ['feed', 'insiders', '--since', '2023-02-29'], ['notices', '--since', '2026-13-01'],
  ['feed', 'insiders', '--entity', 'fut:GC'], ['feed', 'congress', '--entity', 'congress:TEST'], ['feed', 'positioning', '--entity', 'equity:AAPL'],
  ['feed', 'positioning', '--entity', 'fut:gc'], ['feed', 'positioning', '--entity', 'fut:ABCDEFG'], ['feed', 'positioning', '--ticker', 'AAPL'],
  ['feed', 'insiders', '--ticker', 'AAPL', '--entity', 'equity:AAPL'], ['events', 'AAPL', '--source', 'CTGOV'],
  ['events', 'AAPL', '--type', 'a'.repeat(41)], ['events', 'AAPL', '--cursor', 'abc'], ['notices', '--min-value', '-1'],
  ['catalog', '--format', 'yaml'], ['auth', 'login', '--key', 'secret'], ['auth', 'status', 'extra'],
];
test('invalid and excluded commands reject before credentials or transport', async () => {
  let reads = 0;
  const auth = { get env() { reads++; throw new Error('Credential read should be impossible'); } };
  for (const args of negatives) {
    const result = await execute([...args, '--format', 'json'], { auth });
    assert.equal(result.exit, 2, args.join(' ')); assert.equal(result.ledger.length, 0, args.join(' '));
    assert.equal(JSON.parse(result.out).error.code, 'invalid_input', args.join(' '));
  }
  assert.equal(reads, 0);
});

test('opaque cursor is forwarded unchanged with pinned route/filter/limit and never credential', async () => {
  const args = ['feed', 'insiders', '--ticker', 'AAPL', '--since', '2024-02-29', '--limit', '20'];
  const spec = parseCommand(args);
  const opaque = 'opaque?+/%= provider:not-a-client-schema';
  const token = continuation(spec, opaque);
  const result = await execute([...args, '--cursor', token, '--format', 'json']);
  assert.equal(result.exit, 0); assert.equal(result.ledger.length, 1);
  assert.equal(new URL(result.ledger[0].url).searchParams.get('cursor'), opaque);
  assert.ok(!token.includes('synthetic-test-key'));
  const payload = JSON.parse(Buffer.from(token, 'base64url'));
  const mutations = [{ origin: 'https://invest.compoundinterest.ing' }, { route: '/v1/feed/congress' }, { query: 'limit=20' }, { limit: 19 }, { schema: 2 }, { cursor: '' }, { extra: 1 }];
  for (const mutation of mutations) {
    const changed = Buffer.from(JSON.stringify({ ...payload, ...mutation })).toString('base64url');
    const bad = await execute([...args, '--cursor', changed, '--format', 'json']);
    assert.equal(bad.exit, 2); assert.equal(bad.ledger.length, 0);
  }
  for (const changed of [args.map(v => v === '20' ? '19' : v), ['feed', 'congress', '--ticker', 'AAPL', '--since', '2024-02-29'], ['feed', 'insiders', '--ticker', 'MSFT', '--since', '2024-02-29']]) {
    const bad = await execute([...changed, '--cursor', token, '--format', 'json']);
    assert.equal(bad.exit, 2); assert.equal(bad.ledger.length, 0);
  }
});

test('received continuation belongs to client metadata; provider response remains identical', async () => {
  const body = envelope('feed insiders'); body.data.next_cursor = 'provider-opaque:not-json';
  const result = await execute(['feed', 'insiders', '--format', 'json'], { fetcher: async () => Response.json(body) });
  assert.equal(result.exit, 0);
  const parsed = JSON.parse(result.out);
  assert.deepEqual(parsed.data, body.data); assert.deepEqual(parsed.meta, body.meta);
  assert.equal(JSON.parse(Buffer.from(parsed.client.continuation, 'base64url')).cursor, body.data.next_cursor);
});
