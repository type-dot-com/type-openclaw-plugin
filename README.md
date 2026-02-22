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

Then configure the channel:

```json
{
  "channels": {
    "type": {
      "enabled": true,
      "token": "ta_your_agent_token",
      "wsUrl": "wss://your-type-server/api/agents/ws",
      "agentId": "agent_..."
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Agent token from Type UI (`ta_`-prefixed) |
| `wsUrl` | Yes | Type server WebSocket endpoint |
| `agentId` | Yes | Agent ID from Type (shown in agent builder) |

> **Note:** Set `agents.defaults.verboseDefault` to `"on"` in your OpenClaw config to enable streaming via `onPartialReply` callbacks.

## Documentation

See [SKILL.md](./SKILL.md) for the full protocol reference, streaming details, and troubleshooting guide.

## License

[MIT](./LICENSE)
