import { parseCommand, continuation } from './commands.mjs';
import { authContext, authStatus, credential, saveCredential, logout, readKey } from './auth.mjs';
import { request } from './client.mjs';
import { CliError, cancelled } from './errors.mjs';
import { render, json, clean } from './output.mjs';

export const HELP = `Compound Interesting — read-only Data API client
Usage: compoundinterest COMMAND [arguments] [--format table|json]

  catalog                      Public capability catalogue (no key)
  demo                         Fixed AAPL demo (no key)
  search QUERY                 Search ticker/company names
  ticker SYMBOL                Tier-sliced composite
  consensus SYMBOL             Cross-signal consensus
  screen                       Bounded equity screen (default 10)
  feed insiders|congress|positioning   Bounded disclosure/positioning page
  events SYMBOL                Newest matching events (default 30)
  notices                      Form 144 proposed-sale notices (default 20)
  evidence SYMBOL              Published evidence (paid depth)
  rating SYMBOL                House rating or null (paid depth)
  auth login [--stdin]          Store a local plaintext key; no network
  auth status                  Show credential source; no key output
  auth logout                  Remove stored file only; no network

screen: --sector --rating buy|hold|sell --state --min-confidence 0..1
        --min-completeness 0..1 --flagged --sort --order asc|desc --limit 1..500
feeds:  --entity --ticker (insiders/congress) --since YYYY-MM-DD --limit
        --cursor TOKEN (reuse identical filters and limit)
events: --source --type --limit 1..200
notices: --since --ticker --min-value --limit 1..100 --cursor TOKEN
Insider/positioning max 200; Congress max 20; feeds default 20.
States: accumulation, distribution, event_driven, elevated_risk, mixed,
        quiet, activist_target, settlement_stress.
Sort: confidence, data_completeness, consensus_strength, house_rating_confidence.
Rating filters/sort need paid depth. Server limits/rights remain authoritative.
CI_API_KEY takes precedence over an explicitly stored key. Do not pass keys in argv.
No automatic pagination, retry, data cache, origin fallback, or inference.
Ownership, Form D, member history, bulk and write commands are excluded.
Research observations are not financial advice. See the package README.
`;

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const defaultFormat = stdout.isTTY ? 'table' : 'json';
  let spec;
  try {
    spec = parseCommand(argv);
    if (!argv.includes('--format')) spec.format = defaultFormat;
    if (spec.command === 'help') { stdout.write(spec.format === 'json' ? json({ help: HELP }) : HELP); return 0; }
    if (io.signal?.aborted) throw cancelled();
    const ctx = () => io.auth ?? authContext();
    let result;
    if (spec.command === 'auth login') {
      stderr.write('The credential file stores your API key as local plaintext with private permissions.\n');
      result = { data: await saveCredential(await readKey(stdin, stderr, spec.stdin), ctx()), meta: {} };
    } else if (spec.command === 'auth status') result = { data: await authStatus(ctx()), meta: {} };
    else if (spec.command === 'auth logout') result = { data: await logout(ctx()), meta: {} };
    else {
      const key = spec.keyless ? undefined : await credential(ctx());
      result = await request(spec, key, { fetcher: io.fetcher, signal: io.signal, deadline: io.deadline });
    }
    const client = { schema: 1, command: spec.command, received_at: new Date().toISOString() };
    if (['feed insiders', 'feed congress', 'feed positioning', 'notices'].includes(spec.command)) {
      const token = continuation(spec, result.data.next_cursor);
      if (token) client.continuation = token;
    }
    stdout.write(render({ data: result.data, meta: result.meta, client }, spec.format));
    return 0;
  } catch (raw) {
    if (raw?.code === 'EPIPE') return 0;
    const e = raw instanceof CliError ? raw : new CliError('local_error', 'The command could not be completed safely.');
    const payload = { error: { code: e.code, message: e.message, status: e.status, ...(e.hint ? { hint: e.hint } : {}) } };
    const format = spec?.format ?? (argv.some((v, i) => v === '--format' && argv[i + 1] === 'json') ? 'json' : argv.some((v, i) => v === '--format' && argv[i + 1] === 'table') ? 'table' : defaultFormat);
    if (format === 'json') stdout.write(json(payload));
    else stderr.write(`${clean(e.code)}: ${clean(e.message)}${e.status === null ? '' : ` (HTTP ${e.status})`}${e.hint ? ` ${json(e.hint).trim()}` : ''}\n`);
    return e.exit;
  }
}
