# Compound Interesting

Source-backed US market intelligence for AI agents and terminals: insider
(SEC Form 4) filings, House and Senate trading disclosures, institutional (13F)
positioning and a cross-signal consensus across about 4,600 US tickers. Records
link to the filing or disclosure they came from where one is available.

Website: [compoundinterest.ing](https://compoundinterest.ing) ·
MCP setup: [compoundinterest.ing/mcp](https://compoundinterest.ing/mcp)

This repository holds the open-source clients (MIT):

| Client | Where |
| --- | --- |
| Remote MCP server (hosted) | `https://api.compoundinterest.ing/mcp` (Streamable HTTP, bearer key) |
| Command-line client | [`cli/`](cli/) · [`@compoundinteresting/cli`](https://www.npmjs.com/package/@compoundinteresting/cli) on npm |
| Claude Code / Codex plugin | [`plugins/compoundinterest/`](plugins/compoundinterest/) |

The server and the data service are not in this repository.

## Get a free key

Sign up at [compoundinterest.ing/signup](https://compoundinterest.ing/signup)
(no card), then create a key at
[compoundinterest.ing/account](https://compoundinterest.ing/account). The free
tier covers 100 units a day. Paid keys are not on sale yet. Never paste a key
into a model conversation or commit it.

## Connect the MCP server

Claude Code:

```sh
claude mcp add --transport http compoundinterest https://api.compoundinterest.ing/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "compoundinterest": {
      "type": "http",
      "url": "https://api.compoundinterest.ing/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

Tools: `get_composite`, `get_consensus`, `rank_consensus`, `screen`,
`search_tickers`, `list_insider_trades`, `list_congress_trades`,
`list_positioning`, `get_monthly_activity`, `get_historic_moves`,
`get_equity_perp`, `list_equity_perp` and `get_signal`. `get_evidence` and
`get_house_rating` need a paid key. `get_demo_composite` works without a key, so
an agent can see the data shape first.

## Command line

```sh
npm install -g @compoundinteresting/cli
compoundinterest demo
compoundinterest auth login
compoundinterest ticker NVDA
```

Node 22 or later, macOS and Linux. See [`cli/README.md`](cli/README.md).

## Claude Code plugin

```sh
/plugin marketplace add tamler/compoundinteresting
/plugin install compoundinterest@compoundinteresting
```

Three read-only skills: ticker research, comparison of up to three tickers and a
bounded screen. Set `CI_API_KEY` in your environment first. See
[`plugins/compoundinterest/README.md`](plugins/compoundinterest/README.md).

## Notes

Observations about securities, not investment advice. Compound Interesting is
not a registered investment advisor. The client code here is MIT-licensed (see
[LICENSE](LICENSE)); API access and data are subject to the service
[terms](https://compoundinterest.ing/terms).
