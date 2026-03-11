# Type Channel Plugin for OpenClaw

Connect OpenClaw agents to Type team chat via a duplex WebSocket.

## Setup

### 1. OpenClaw Config (`~/.openclaw/openclaw.json`)

```json
{
  "agents": {
    "defaults": {
      "verboseDefault": "on"
    }
  },
  "channels": {
    "type": {
      "accounts": {
        "default": {
          "enabled": true,
          "token": "ta_your_agent_token",
          "wsUrl": "wss://your-type-server/api/agents/ws",
          "agentId": "agent_...",
          "capabilities": ["media"],
          "mediaLocalRoots": ["/home/daytona/.openclaw/workspace"],
          "ownerAllowFrom": ["user_123"]
        }
      }
    }
  }
}
```

**`agents.defaults.verboseDefault`** must be set to `"on"`. This enables `onToolResult` callbacks so tool outputs can be streamed to Type.

#### Multi-account support

Each key under `accounts` is a named account that maintains its own WebSocket connection to a different Type agent. Use `bindings` to route each account to the appropriate OpenClaw agent workspace:

```json
{
  "channels": {
    "type": {
      "accounts": {
        "default": { "enabled": true, "token": "ta_...", "wsUrl": "wss://...", "agentId": "..." },
        "code-agent": { "enabled": true, "token": "ta_...", "wsUrl": "wss://...", "agentId": "..." }
      }
    }
  },
  "bindings": [
    { "agentId": "main", "match": { "channel": "type", "accountId": "default" } },
    { "agentId": "code", "match": { "channel": "type", "accountId": "code-agent" } }
  ]
}
```

Each account is fully isolated — sessions, ack tracking, and disconnect handling are scoped per account, so one account disconnecting does not affect others.

| Account Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Agent token from Type UI (`ta_`-prefixed) |
| `wsUrl` | Yes | Type server WebSocket endpoint |
| `agentId` | Yes | Agent ID from Type (shown in agent builder) |
| `capabilities` | No | Array of capabilities (e.g. `["media"]`) |
| `mediaLocalRoots` | Recommended | Allowed local directories for `sendMedia` local file paths |
| `ownerAllowFrom` | No | Type user IDs that should be treated as owner senders for owner-only tools |

> Legacy single-account config (flat fields at the `type` level) is still supported but deprecated.

### 2. Plugin Registration

Add to `plugins.load.paths` in your OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/plugins/type"]
    }
  }
}
```

## How It Works

### Connection

The plugin maintains a duplex WebSocket per account to the Type server. All communication for an account flows over its connection:

- **Type -> Agent**: message triggers, ping keepalive
- **Agent -> Type**: pong, streaming responses, proactive messages

The connection auto-reconnects with exponential backoff (1s base, 60s max, with jitter). Code 4000 means "replaced by another connection" and skips reconnect to avoid storms.

### Message Flow

1. User mentions the agent in Type (channel or DM)
2. Type creates a streaming placeholder message and sends a `message` trigger over WS
3. Plugin dispatches through OpenClaw's standard agent reply pipeline
4. Agent generates response; `onPartialReply` fires with accumulated text
5. Plugin streams deltas to Type: `stream_start` -> `stream_event` (tokens) -> `stream_finish`
6. Type accumulates text and publishes real-time updates to connected clients

### Streaming Protocol

**Critical ordering**: `stream_start` must be acknowledged by the server before sending any `stream_event`. The server does async DB validation (agent run lookup, message validation) before creating stream state. Sending `stream_event` before the state exists results in "No active stream" errors.

The plugin handles this with an ack gate (`StreamSession`):

```
onPartialReply(text1) -> send stream_start -> await server "success" ack
                                            -> send stream_event(delta1)
onPartialReply(text2) -> send stream_event(delta2)  (streamReady already resolved)
onPartialReply(text3) -> send stream_event(delta3)
dispatch complete     -> send stream_finish
```

The plugin sets `disableBlockStreaming: true` in `replyOptions` and uses `onPartialReply` for text streaming. Tool outputs arrive via the `deliver` callback (with `info.kind === "tool"`) and are forwarded as `tool-call` + `tool-result` stream events.

## WebSocket Message Reference

### Server -> Agent

| Type | Description |
|------|-------------|
| `message` | Agent was triggered (mentioned in channel or DM) |
| `ping` | Keepalive (reply with `pong`) |
| `success` | Ack for a previous outbound message |
| `error` | Error for a previous outbound message |

### Agent -> Server

| Type | Description |
|------|-------------|
| `pong` | Reply to ping |
| `send` | Proactive message to a channel |
| `stream_start` | Begin streaming response |
| `stream_event` | Stream token/tool-call/tool-result |
| `stream_finish` | End streaming response |

### Stream Event Kinds

| Kind | Fields | Description |
|------|--------|-------------|
| `token` | `text` | Text delta |
| `tool-call` | `toolCallId, toolName, input` | Tool invocation started |
| `tool-result` | `toolCallId, toolName, outcomes` | Tool completed |

## Troubleshooting

### No streaming (response arrives all at once)

- Ensure `agents.defaults.verboseDefault` is `"on"` in `~/.openclaw/openclaw.json`
- For short responses, `onPartialReply` may fire only once — this is expected

### Agent doesn't respond at all

- Check the gateway logs for `[type]` prefixed messages
- Verify the WS connection is established (`[type] WebSocket connected`)
- Confirm the agent token and agent ID match the Type UI config

### Message stuck in streaming state

- The connection likely dropped mid-stream before `stream_finish` was sent
- Server auto-cancels after 30s idle timeout; agent timeout (120s default) is the final safety net
