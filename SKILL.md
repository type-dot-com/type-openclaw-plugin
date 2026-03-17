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
          "mediaLocalRoots": ["~/.openclaw/workspace"],
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
| `enabled` | No | Whether the account is active (default: `false`) |
| `token` | Yes | Agent token from Type UI (`ta_`-prefixed) |
| `wsUrl` | Yes | Type server WebSocket endpoint |
| `agentId` | Yes | Agent ID from Type (shown in agent builder) |
| `capabilities` | No | Array of capabilities (e.g. `["media"]`) — OpenClaw-level, not parsed by this plugin |
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

## Agent Tools

The plugin registers tools that the agent can call during conversations:

### `ask_user`

Ask the user a question and wait for their reply. Use when clarification, approval, or input is needed before proceeding.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | Yes | The question to ask the user |

## Inbound Context Reference

When a message trigger arrives from Type, the plugin builds an OpenClaw inbound context payload with the following fields. See `messageHandler.ts` for the full construction.

### Message Body

| Field | Type | Description |
|-------|------|-------------|
| `Body` | `string` | Message content (falls back to `"See attached files."` when body is empty but files are present) |
| `BodyForAgent` | `string` | Same as `Body` |
| `BodyForCommands` | `string` | Raw message text, unmodified |
| `RawBody` | `string` | Raw message text, unmodified |
| `CommandBody` | `string` | Raw message text, unmodified |
| `CommandAuthorized` | `boolean` | Always `true` |

### Sender & Routing

| Field | Type | Description |
|-------|------|-------------|
| `From` | `string` | Sender identifier, format: `type:{senderId}` |
| `To` | `string` | Channel ID (`ch_*` format — use this value as `channelId` when sending messages back to this conversation) |
| `SenderId` | `string` | Type user ID of the message sender |
| `SenderName` | `string` | Display name of the sender |
| `AccountId` | `string` | Type account key from plugin config (e.g. `"default"`) |
| `Provider` | `string` | Always `"type"` |
| `Surface` | `string` | Always `"type"` |
| `MessageSid` | `string` | Type message ID |
| `Timestamp` | `number` | Message timestamp in milliseconds |

### Session & Chat Type

| Field | Type | Description |
|-------|------|-------------|
| `SessionKey` | `string` | Agent-scoped session key. Format varies by chat type: agent DM → `agent:{agentId}:type:{replyTarget.parentMessageId}` (falls back to `{channelId}:{messageId}`), thread → `agent:{agentId}:type:{replyTarget.parentMessageId}` (falls back to `{channelId}:{messageId}`), DM → `agent:{agentId}:type:{channelId}`, channel → `agent:{agentId}:type:{channelId}:{messageId}` |
| `ChatType` | `"direct" \| "channel"` | `"direct"` for DMs and agent DMs, `"channel"` for channels and threads |
| `ConversationLabel` | `string` | Channel name, falls back to channel ID |
| `GroupChannel` | `string` | Channel name or description for group context |
| `GroupSubject` | `string \| null` | Channel description, or `null` if unavailable |

### Routing Metadata

| Field | Type | Description |
|-------|------|-------------|
| `TypeChannelType` | `"default" \| "alert" \| "agent_dm"` | The channel type. `"agent_dm"` indicates an agent DM conversation |
| `TypeConversationRootMessageId` | `string \| null` | The root message ID for the conversation thread (set for agent DMs and threads) |
| `TypeReplyTarget` | `{channelId: string, parentMessageId: string \| null}` | The canonical reply target. Always use `TypeReplyTarget.channelId` (a `ch_*` ID) as the `channelId` when sending messages or media — never use channel names like `ConversationLabel` or `GroupChannel` |

### Thread Context

| Field | Type | Description |
|-------|------|-------------|
| `ThreadLabel` | `string \| null` | Thread title if the message is in a thread |
| `ThreadStarterBody` | `string \| undefined` | Content of the first message in the thread |
| `ThreadHistoryBody` | `string \| undefined` | Prior thread messages formatted as `{sender}: {body}`, double-newline separated |
| `MessageThreadId` | `string \| undefined` | Parent message ID (set only for thread messages) |
| `ReplyToId` | `string \| undefined` | Parent message ID if replying |

### History

| Field | Type | Description |
|-------|------|-------------|
| `InboundHistory` | `InboundHistoryEntry[] \| undefined` | Recent messages in the channel/conversation, each with sender name, body, and timestamp. Built from `context.recentMessages` |

### Media & Files

| Field | Type | Description |
|-------|------|-------------|
| `Files` | `Array<{id, filename, mimeType, sizeBytes, url}>` | Attached files with presigned download URLs |
| `MediaUrl` | `string \| undefined` | Download URL of the first attached file |
| `MediaUrls` | `string[] \| undefined` | Download URLs of all attached files |
| `MediaType` | `string \| undefined` | MIME type of the first attached file |
| `MediaTypes` | `string[] \| undefined` | MIME types of all attached files |

### Permissions & Extended Context

| Field | Type | Description |
|-------|------|-------------|
| `OwnerAllowFrom` | `string[] \| undefined` | Type user IDs treated as owners (from account config `ownerAllowFrom`) |
| `UntrustedContext` | `string[] \| undefined` | Human-readable text blocks summarizing channel metadata, thread metadata, and file listings. Marked "untrusted" because the content originates from user-generated data |
| `TypeTriggerContext` | `object \| null` | Raw Type trigger context containing `triggeringUser`, `channel` (name, description, visibility, members with roles), `thread` (parentMessageId, title, messages), and `recentMessages` |

## WebSocket Message Reference

### Server -> Agent

| Type | Description |
|------|-------------|
| `message` | Agent was triggered (mentioned in channel or DM) |
| `ping` | Keepalive (reply with `pong`) |
| `success` | Ack for a previous outbound message (`requestType` + optional `messageId`) |
| `error` | Error for a previous outbound message (`requestType`, `error`, optional `messageId`, `details`) |
| `stream_cancel` | User cancelled an active streaming response (`messageId`) |

### Agent -> Server

| Type | Description |
|------|-------------|
| `ping` | Client-initiated keepalive (sent every 30s) |
| `pong` | Reply to server ping |
| `trigger_received` | Acknowledge receipt of a message trigger |
| `respond` | Non-streaming full response to a triggered message |
| `send` | Proactive message to a channel or DM |
| `stream_start` | Begin streaming response |
| `stream_event` | Stream token/tool-call/tool-result |
| `stream_heartbeat` | Keep an active stream alive while no tokens/events are emitted (sent every 10s) |
| `stream_finish` | End streaming response |

### Outbound Message Fields

#### `trigger_received`

| Field | Required | Description |
|-------|----------|-------------|
| `messageId` | Yes | The message ID being acknowledged |
| `receivedAt` | No | Timestamp (ms) when the trigger was received |

#### `respond`

| Field | Required | Description |
|-------|----------|-------------|
| `messageId` | Yes | The triggered message ID to respond to |
| `content` | Yes | Full response text |
| `fileIds` | No | Uploaded file IDs to attach |
| `needsReply` | No | Signal that the agent expects a reply from the user |
| `question` | No | Question text for the UI when `needsReply` is true |

#### `send`

| Field | Required | Description |
|-------|----------|-------------|
| `channelId` | Yes | Target channel ID (`ch_*` format from the inbound `To` or `TypeReplyTarget.channelId` field — do not use channel names) |
| `content` | Yes | Message text |
| `parentMessageId` | No | Parent message ID for thread replies |
| `fileIds` | No | Uploaded file IDs to attach |

#### `stream_finish`

| Field | Required | Description |
|-------|----------|-------------|
| `messageId` | Yes | The streaming message ID |
| `fileIds` | No | Uploaded file IDs to attach |
| `needsReply` | No | Signal that the agent expects a reply from the user |
| `question` | No | Question text for the UI when `needsReply` is true |

### Stream Event Kinds

| Kind | Fields | Description |
|------|--------|-------------|
| `token` | `text` | Text delta |
| `tool-call` | `toolCallId, toolName, input` | Tool invocation started |
| `tool-result` | `toolCallId, toolName, outcomes` | Tool completed (outcomes: `[{kind, toolName, text}]`) |

## Setup Notes

- **`tools.profile`**: Must be set to `"full"` in `~/.openclaw/openclaw.json`. The `"coding"` profile filters out channel plugin tools (including `ask_user`).

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
