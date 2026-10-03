import { inputError, responseError } from './errors.mjs';

export const ORIGIN = 'https://api.compoundinterest.ing';
export const STATES = ['accumulation', 'distribution', 'event_driven', 'elevated_risk', 'mixed', 'quiet', 'activist_target', 'settlement_stress'];
export const SORTS = ['confidence', 'data_completeness', 'consensus_strength', 'house_rating_confidence'];
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;
const CURSOR_MAX = 16 * 1024;

export function symbol(raw) {
  const s = raw.trim().toUpperCase();
  if (!/^(?=.{1,8}$)[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(s)) throw inputError();
  return s;
}

function number(raw, min, max, integer = false) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw inputError();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)))) throw inputError();
  return String(n);
}

function date(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw inputError();
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== raw) throw inputError();
  return raw;
}

function choice(raw, values) {
  if (!values.includes(raw)) throw inputError();
  return raw;
}

export function parseCommand(argv) {
  if (argv.some(a => typeof a !== 'string' || a.length > CURSOR_MAX || CONTROL.test(a))) throw inputError();
  const flags = new Map();
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (a.startsWith('-')) throw inputError();
      args.push(a);
      continue;
    }
    const k = a.slice(2);
    if (flags.has(k) || !/^[a-z]+(?:-[a-z]+)*$/.test(k)) throw inputError();
    if (['help', 'flagged', 'stdin'].includes(k)) flags.set(k, true);
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--') || v.length === 0) throw inputError();
      flags.set(k, v);
    }
  }
  const format = flags.has('format') ? choice(flags.get('format'), ['json', 'table']) : 'table';
  if (flags.has('help') || args.length === 0) {
    if ([...flags.keys()].some(k => !['help', 'format'].includes(k))) throw inputError();
    return { command: 'help', format };
  }
  const command = args[0] === 'feed' || args[0] === 'auth' ? args.slice(0, 2).join(' ') : args[0];
  const positional = args.slice(command.includes(' ') ? 2 : 1);
  const q = new URLSearchParams();
  let path;
  let allowed = [];
  let arity = 0;
  let keyless = false;
  let limit;
  switch (command) {
    case 'catalog': path = '/v1/catalog'; keyless = true; break;
    case 'demo': path = '/v1/demo/composite'; keyless = true; break;
    case 'search': path = '/v1/search'; arity = 1; break;
    case 'ticker': case 'evidence': case 'rating': case 'consensus': case 'events':
      arity = 1;
      path = { ticker: '/v1/composite/', evidence: '/v1/evidence/', rating: '/v1/house-rating/', consensus: '/v1/consensus', events: '/v1/events' }[command];
      if (command === 'events') { allowed = ['source', 'type', 'limit']; limit = 30; }
      break;
    case 'screen':
      path = '/v1/screen'; limit = 10;
      allowed = ['sector', 'rating', 'state', 'min-confidence', 'min-completeness', 'flagged', 'sort', 'order', 'limit'];
      break;
    case 'feed insiders': case 'feed congress': case 'feed positioning':
      path = `/v1/feed/${args[1]}`; limit = 20;
      allowed = ['entity', 'since', 'limit', 'cursor', ...(args[1] === 'positioning' ? [] : ['ticker'])];
      break;
    case 'notices':
      path = '/v1/form-144/filings'; limit = 20;
      allowed = ['since', 'ticker', 'min-value', 'limit', 'cursor'];
      break;
    case 'auth login': allowed = ['stdin']; break;
    case 'auth status': case 'auth logout': break;
    default: throw inputError();
  }
  if (positional.length !== arity || [...flags.keys()].some(k => !['format', ...allowed].includes(k))) throw inputError();
  if (command === 'search') {
    const query = positional[0].trim();
    if (!query || query.length > 256) throw inputError();
    q.set('q', query);
  } else if (arity === 1) {
    const ticker = symbol(positional[0]);
    if (command === 'consensus') q.set('ticker', ticker);
    else if (command === 'events') q.set('entity_id', `equity:${ticker}`);
    else path += encodeURIComponent(ticker);
  }
  if (flags.has('entity') && flags.has('ticker')) throw inputError();
  for (const [k, v] of flags) {
    if (['format', 'cursor', 'stdin', 'limit'].includes(k)) continue;
    switch (k) {
      case 'entity': {
        let entity;
        if (command === 'feed positioning') {
          if (!/^fut:[A-Z0-9]{1,6}$/.test(v)) throw inputError();
          entity = v;
        } else {
          if (!v.startsWith('equity:')) throw inputError();
          entity = `equity:${symbol(v.slice(7))}`;
        }
        q.set('entity_id', entity); break;
      }
      case 'ticker': q.set(command === 'notices' ? 'ticker' : 'entity_id', command === 'notices' ? symbol(v) : `equity:${symbol(v)}`); break;
      case 'since': q.set(k, date(v)); break;
      case 'source': case 'type': if (!/^[a-z0-9_]{1,40}$/.test(v)) throw inputError(); q.set(k, v); break;
      case 'state': q.set(k, choice(v, STATES)); break;
      case 'sort': q.set(k, choice(v, SORTS)); break;
      case 'order': q.set(k, choice(v, ['asc', 'desc'])); break;
      case 'rating': q.set(k, choice(v, ['buy', 'hold', 'sell'])); break;
      case 'min-confidence': case 'min-completeness': q.set(k.replace('-', '_'), number(v, 0, 1)); break;
      case 'min-value': q.set('min_value', number(v, 0, Number.MAX_VALUE)); break;
      case 'flagged': q.set(k, '1'); break;
      case 'sector': if (!v.trim() || v.length > 128) throw inputError(); q.set(k, v); break;
      default: throw inputError();
    }
  }
  if (limit !== undefined) {
    const cap = command === 'screen' ? 500 : command === 'notices' ? 100 : command === 'feed congress' ? 20 : 200;
    limit = flags.has('limit') ? Number(number(flags.get('limit'), 1, cap, true)) : limit;
    q.set('limit', String(limit));
  }
  q.sort();
  const canonical = q.toString();
  const spec = { command, format, path, keyless, limit, query: canonical, stdin: flags.has('stdin') };
  if (flags.has('cursor')) q.set('cursor', decodeContinuation(flags.get('cursor'), spec));
  spec.url = path ? `${ORIGIN}${path}${q.size ? `?${q}` : ''}` : undefined;
  return spec;
}

function decodeContinuation(raw, spec) {
  try {
    if (raw.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) throw inputError();
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw inputError();
    const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!c || Object.keys(c).sort().join() !== 'cursor,limit,origin,query,route,schema' || c.schema !== 1 || c.origin !== ORIGIN || c.route !== spec.path || c.query !== spec.query || c.limit !== spec.limit || typeof c.cursor !== 'string' || !c.cursor || c.cursor.length > CURSOR_MAX || CONTROL.test(c.cursor)) throw inputError();
    return c.cursor;
  } catch { throw inputError(); }
}

export function continuation(spec, cursor) {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor !== 'string' || !cursor || CONTROL.test(cursor)) throw responseError();
  const token = Buffer.from(JSON.stringify({ schema: 1, origin: ORIGIN, route: spec.path, query: spec.query, limit: spec.limit, cursor })).toString('base64url');
  if (token.length > CURSOR_MAX) throw responseError();
  return token;
}
