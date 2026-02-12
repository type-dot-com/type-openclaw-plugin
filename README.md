# @openclaw/type

OpenClaw channel plugin for [Type](https://type.chat) team chat integration via WebSocket.

Connects OpenClaw agents to Type so users can mention an agent in any channel or DM and get streaming responses in real time.

## Features

- Duplex WebSocket connection with auto-reconnect and exponential backoff
- Real-time token streaming (`stream_start` -> `stream_event` -> `stream_finish`)
- Tool call/result forwarding during agent execution
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
      "wsUrl": "ws://your-type-server:3000/api/agents/ws",
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
