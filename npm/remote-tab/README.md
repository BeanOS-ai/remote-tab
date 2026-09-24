# remote-tab

Agent tools for [Remote Tab](https://beanos.ai/remote-tab/): an AI agent uses
one tab in a person's own Chrome, with the person's consent and end-to-end
encryption. The person installs the
[Remote Tab extension](https://chromewebstore.google.com/detail/remote-tab/biebcindoglbblcohgdbphemcapnlpoh)
and shares a tab with a one-time code that the agent creates.

The full agent guide is at <https://tab.beanos.ai/docs>. The CLI is the
preferred interface. Node.js 20 or newer is required.

## CLI (preferred)

```sh
export REMOTE_TAB_SERVER_URL=https://tab.beanos.ai
STATE="$(mktemp -d)/session.json"
npx -y remote-tab create --state "$STATE" --ttl 1800   # secret code: deliver privately
npx -y remote-tab wait-ready --state "$STATE" --timeout-ms 120000
npx -y remote-tab browser_snapshot --state "$STATE"
npx -y remote-tab stop --state "$STATE"
```

`npx -y remote-tab --help` lists every command, and `npx -y remote-tab skill`
prints the agent skill: the consent and private-delivery rules to follow. Output
is JSON on stdout. Errors are JSON on stderr with a nonzero exit code.

## MCP server

```json
{
  "mcpServers": {
    "remote-tab": {
      "command": "npx",
      "args": ["-y", "-p", "remote-tab", "remote-tab-mcp"],
      "env": { "REMOTE_TAB_SERVER_URL": "https://tab.beanos.ai" }
    }
  }
}
```

A self-hosted relay works the same way: set `REMOTE_TAB_SERVER_URL` to its
origin. `REMOTE_TAB_API_KEY` is optional.

## License

MIT
