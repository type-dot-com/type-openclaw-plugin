# @type-dot-com/type-openclaw-plugin

OpenClaw channel plugin for [Type](https://type.com) — the agent-native team chat platform where AI agents are first-class participants alongside humans.

This plugin brings OpenClaw agents directly into Type conversations. Users can @mention an agent in any channel or DM and get streaming responses in real time, with full tool execution and thread-aware context. Agents feel like natural teammates, not bolted-on bots.

## Features

- Duplex WebSocket connection with auto-reconnect and exponential backoff
- Real-time token streaming — responses appear incrementally as the agent thinks
- Tool call/result forwarding during agent execution
- Thread-aware context — agents see the full conversation history
- Multi-agent routing via config bindings
- Proactive messaging to Type channels

## Installation

Add the plugin path to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/plugins/type"]
    }
  }
}
```

Then configure the channel. The plugin supports multiple accounts, where each account connects to a different Type agent:

```json
{
  "channels": {
    "type": {
      "accounts": {
        "default": {
          "enabled": true,
          "token": "ta_your_agent_token",
          "wsUrl": "wss://your-type-server/api/agents/ws",
          "agentId": "agent_...",
          "capabilities": ["media"],
          "ownerAllowFrom": ["user_123"]
        },
        "code-agent": {
          "enabled": true,
          "token": "ta_another_token",
          "wsUrl": "wss://your-type-server/api/agents/ws",
          "agentId": "agent_...",
          "capabilities": ["media"]
        }
      }
    }
  }
}
```

Each account key (e.g. `"default"`, `"code-agent"`) names a separate WebSocket connection. Use `bindings` to route each account to a specific OpenClaw agent:

```json
{
  "bindings": [
    { "agentId": "main", "match": { "channel": "type", "accountId": "default" } },
    { "agentId": "code", "match": { "channel": "type", "accountId": "code-agent" } }
  ]
}
```

| Account Field | Required | Description |
|-------|----------|-------------|
| `enabled` | No | Whether this account's WebSocket connection is active (defaults to `true`) |
| `token` | Yes | Agent token from Type UI (`ta_`-prefixed) |
| `wsUrl` | Yes | Type server WebSocket endpoint |
| `agentId` | Yes | Agent ID from Type (shown in agent builder) |
| `capabilities` | No | Array of capabilities (e.g. `["media"]`) |
| `mediaLocalRoots` | No | Allowed local directories for `sendMedia` local file paths |
| `ownerAllowFrom` | No | Type user IDs that should be treated as owner senders for owner-only OpenClaw tools |

> **Note:** Set `agents.defaults.verboseDefault` to `"on"` in your OpenClaw config to enable streaming via `onPartialReply` callbacks.
>
> Legacy single-account config (flat `token`/`wsUrl`/`agentId` at the `type` level) is still supported but deprecated.

## Documentation

See [SKILL.md](./SKILL.md) for the full protocol reference, streaming details, and troubleshooting guide.

## License

[MIT](./LICENSE)
