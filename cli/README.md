# Compound Interesting CLI

Read the [Compound Interesting](https://compoundinterest.ing) Data API from a
terminal or script: insider (SEC Form 4), Congressional and institutional
disclosure signals for US companies. Node 22 or later, macOS and Linux. No model
calls, telemetry, data cache, origin fallback or automatic retries. There are no
runtime dependencies or install-time scripts.

```sh
npm install -g @compoundinteresting/cli
compoundinterest --help
```

The same data is available to AI agents over MCP; see
[compoundinterest.ing/mcp](https://compoundinterest.ing/mcp). A free key covers
100 units a day.

The client code is MIT-licensed; see [LICENSE](LICENSE). API access and data are
subject to separate service terms; this license does not relicense the data or
the server.

From a source checkout, run `node cli/src/bin.mjs --help` from the repository
root, and `npm test` in `cli/` for the test suite. Tests use synthetic data and
isolated credentials.

## Start without an account

```sh
compoundinterest catalog --format json
compoundinterest demo
```

These commands never attach a key, even if one is configured. The demo is always
AAPL and is not selectable. Every other data command requires your customer API
key from [your CI account](https://compoundinterest.ing/account).

## Authentication

`CI_API_KEY` takes precedence over an explicitly stored local key. Supply that
environment variable through your terminal or secret manager, not a key argument
or URL. This client does not discover project config, browser cookies, operator
keys or website sessions.

```sh
compoundinterest auth login
compoundinterest auth status
compoundinterest auth logout
```

Login uses a hidden terminal prompt. Scripts may pipe a key into
`compoundinterest auth login --stdin`; input is at most 4096 key bytes plus a single
line terminator. Login does no network validation. Storage is **plaintext**, in
a user-owned 0700 directory and regular 0600 file with one hard link:

- macOS: `~/Library/Application Support/CompoundInterest/credentials.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/compoundinterest/credentials.json`

Unsafe permissions, symlinks, foreign ownership, hard links, malformed JSON or
oversized files are rejected. Status never prints a key, prefix or hash. Logout
removes the stored file only; it leaves `CI_API_KEY` and the server key unchanged.

## Commands and limits

Each data command sends exactly one GET to `https://api.compoundinterest.ing`.
Universal output is `--format table|json` (default table in a terminal, JSON when piped). Limits are explicit
client requests, with the server's stored tier/caps authoritative.

| Command | Default; flags |
| --- | --- |
| `search QUERY` | One quoted company name or symbol fragment |
| `ticker SYMBOL` | Composite; no implicit evidence/rating request |
| `consensus SYMBOL` | One ticker, not ranked consensus |
| `screen` | 10; `--sector`, `--rating buy\|hold\|sell`, `--state`, `--min-confidence`, `--min-completeness`, `--flagged`, `--sort`, `--order asc\|desc`, `--limit 1..500` |
| `feed insiders` | 20; `--ticker` or `--entity equity:SYMBOL`, `--since`, `--limit 1..200`, `--cursor` |
| `feed congress` | 20; same filters, `--limit 1..20` on both free/paid |
| `feed positioning` | 20; `--entity fut:ES` (futures, not equities), `--since`, `--limit 1..200`, `--cursor` |
| `events SYMBOL` | 30; `--source`, `--type`, `--limit 1..200`; newest N, no continuation |
| `notices` | 20; `--ticker`, `--since`, `--min-value`, `--limit 1..100`, `--cursor`; current 180-day Form 144 snapshot |
| `evidence SYMBOL` | Paid depth; published evidence only |
| `rating SYMBOL` | Paid depth; null is valid absence |

Symbols normalize to uppercase, total length 1–8, alphanumeric segments separated
by one dot or hyphen. `since` is a real `YYYY-MM-DD`. Event source/type use 1–40
characters from `a-z`, `0-9`, `_`. Confidence/completeness filters are 0–1.
Unknown/repeated flags, excluded commands and invalid arguments fail before I/O.

States: accumulation, distribution, event_driven, elevated_risk, mixed, quiet,
activist_target, settlement_stress. `activist_target` is displayed as “Large-holder
signal”; it does not prove activism. Sorts: confidence (server default),
data_completeness, consensus_strength, house_rating_confidence. Rating filters and
house-rating sorting require paid depth. `--flagged` uses the API's event/risk
predicate, not every flagged dimension.

Ownership, Form D, Congress member history and homepage-specific views are excluded
pending their applicable publisher/parity gates. Bulk exports, watchlist/account
writes, prices/charts, trades and inference are also excluded.

## Continuation and failures

JSON success preserves server `data` and `meta`, including nulls, unknown fields,
raw enums and attribution. A separate `client` object records schema 1, command,
receipt time and optional continuation. Tables retain reported values, units and
ranges, show metadata and strip terminal controls. Filing URL fields are shown
only for SEC EDGAR archive or House/Senate hosts; otherwise “no filing link”.
JSON preserves raw strings as escaped JSON; the client does not fetch/open links.

Use the `client.continuation` token with **identical filters and requested limit**:

```sh
compoundinterest feed insiders --ticker AAPL --limit 20 --format json
```

Pass the returned token through `--cursor` on the same command. It pins provider,
route and filters, not a legacy feed snapshot. The server cursor is opaque and
unchanged. Some legacy malformed feed cursors restart at a 200 first page; this
client cannot upgrade that server behavior into snapshot consistency. Form 144
generation changes fail with 409 and require an explicit new first-page request. No
`--all`, automatic pagination, filter dropping, clamping or retry is performed.
Free notices reject continuation, limits above 20 or dates outside their coverage;
the client preserves that 400 failure rather than fetching a different page.

Errors preserve HTTP status and known API code with a fixed safe message, never
raw upstream diagnostics. JSON errors go to stdout, table errors to stderr.
Unknown API codes become `upstream_error`. Exit codes:

| Exit | Meaning |
| --- | --- |
| 0 | Valid success, including an explicit empty page/null rating |
| 2 | Invalid local input/configuration or unsupported platform |
| 3 | Missing/invalid/revoked API authentication |
| 4 | Paid depth required |
| 5 | Rate/quota limit; safe retry/reset hint when available, no retry |
| 6 | Remote rejection, forbidden, unavailable, timeout/network, unpublished/withdrawn/deleted/unknown data |
| 7 | Invalid JSON/envelope, invalid shape or decoded body above 16 MiB |
| 130 | Cancellation |

`not_found`, `evidence_not_published`, `retracted` and `gone` remain distinct codes.
One 10-second deadline covers fetch and body; redirects are refused and TLS
verification stays enabled. Broken stdout pipes exit cleanly. Observations are
not financial advice; do not interpret a missing field as zero or a complete
history, or a Form 144 proposed-sale notice as a completed sale.
