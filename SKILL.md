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
      "enabled": true,
      "token": "ta_your_agent_token",
      "wsUrl": "ws://your-type-server:3000/api/agents/ws",
      "agentId": "agent_...",
      "blockStreaming": true
    }
  }
}
```

**`agents.defaults.verboseDefault`** must be set to `"on"`. This enables `onToolResult` callbacks so tool outputs can be streamed to Type.

| Field | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Agent token from Type UI (`ta_`-prefixed) |
| `wsUrl` | Yes | Type server WebSocket endpoint |
| `agentId` | Yes | Agent ID from Type (shown in agent builder) |
| `blockStreaming` | Recommended | Enables progressive block delivery instead of full-response-at-once |

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

The plugin maintains a single duplex WebSocket to the Type server. All communication flows over this one connection:

- **Type -> Agent**: message triggers, ping keepalive
- **Agent -> Type**: pong, streaming responses, proactive messages

The connection auto-reconnects with exponential backoff (1s base, 60s max, with jitter). Code 4000 means "replaced by another connection" and skips reconnect to avoid storms.

### Message Flow

1. User mentions the agent in Type (channel or DM)
2. Type creates a streaming placeholder message and sends a `message` trigger over WS
3. Plugin dispatches through OpenClaw's standard agent reply pipeline
4. Agent generates response; `deliver` callback fires per text block
5. Plugin streams blocks to Type: `stream_start` -> `stream_event` (tokens) -> `stream_finish`
6. Type accumulates text and publishes real-time updates to connected clients

### Streaming Protocol

**Critical ordering**: `stream_start` must be acknowledged by the server before sending any `stream_event`. The server does async DB validation (agent run lookup, message validation) before creating stream state. Sending `stream_event` before the state exists results in "No active stream" errors.

The plugin handles this with an ack gate:

```
deliver(block1) -> send stream_start -> await server "success" ack
                                      -> send stream_event(block1)
deliver(block2) -> send stream_event(block2)  (streamReady already resolved)
deliver(block3) -> send stream_event(block3)
dispatch complete -> send stream_finish
```

### Streaming via `onPartialReply`

The plugin sets `disableBlockStreaming: true` in `replyOptions` and uses the `onPartialReply` callback instead. Combined with `verboseDefault: "on"` at the global agent level, this enables `onToolResult` callbacks so tool outputs are streamed alongside text deltas.

- Set `blockStreaming: true` in the channel config (enables the deliver pipeline)
- Set `disableBlockStreaming: true` in replyOptions (routes through `onPartialReply` instead of block deliver)
- Each partial reply is sent as a `stream_event` with `kind: "token"`

For short responses, `onPartialReply` may fire only once with the full text.

## Server-Side Behavior

### Stream State Management

- **Idle timeout**: 30 seconds of no `stream_event` -> stream is cancelled, message marked as error
- **Agent timeout**: Configurable per-agent (default 120s) -> if no response at all after trigger
- **Max active streams**: 1000 concurrent
- **Update throttle**: 100ms between real-time publishes to clients

### Connection Replacement

When the agent reconnects, the server:
- Keeps the old socket alive (doesn't force-close it)
- Aborts the old socket's trigger subscription and ping interval
- Only fails streams when the **active** connection closes (stale socket close is safe)

### Error Responses

The server sends typed error responses for all operations:

```json
{ "type": "error", "requestType": "stream_start", "error": "Agent run not found" }
{ "type": "error", "requestType": "stream_event", "error": "No active stream for this message" }
```

The plugin logs these and stops streaming on `stream_start` failure.

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
| `respond` | Non-streaming full response to a trigger |
| `stream_start` | Begin streaming response |
| `stream_event` | Stream token/tool-call/tool-result |
| `stream_finish` | End streaming response |

### Stream Event Kinds

| Kind | Fields | Description |
|------|--------|-------------|
| `token` | `text` | Text delta |
| `tool-call` | `toolCallId, toolName, input` | Tool invocation started |
| `tool-result` | `toolCallId, toolName, outcomes` | Tool completed |
| `tool-error` | `toolCallId, toolName, error` | Tool failed |

## Troubleshooting

### Text renders with unwanted paragraph breaks

- Set `breakPreference: "sentence"` in your OpenClaw `blockStreamingChunk` config. The default chunker inserts `\n\n` at line-width boundaries, which Type renders as paragraph breaks in markdown. The `"sentence"` mode uses spaces as joiners instead.
- Type accumulates all stream tokens into a single string (`accumulatedText += chunk`) with no separators — newlines in chunks are preserved as-is and affect markdown rendering.

### Response arrives all at once

- Ensure `blockStreaming: true` is set in the channel config (`~/.openclaw/openclaw.json`)
- For short responses (<300 chars), OpenClaw may deliver as a single block -- this is expected

### "No active stream for this message"

- The `stream_event` arrived before `stream_start` was processed
- This should be fixed by the ack gate, but check logs for `stream_start rejected` errors

### Stream times out (30s idle)

- `stream_event` messages aren't reaching the server
- Check WS connection state and `streamToken send failed` errors in logs

### Message stuck in streaming state

- `stream_finish` failed to send (connection dropped during response)
- Server will auto-fail the stream after 30s idle timeout
- Agent timeout (120s default) is the final safety net
