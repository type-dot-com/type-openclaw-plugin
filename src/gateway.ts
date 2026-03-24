import {
  clearAccountState,
  getAccountState,
  getPluginRuntime,
} from "./accountState.js";
import { resolveAccount } from "./config.js";
import { TypeConnection } from "./connection.js";
import {
  clearInboundTriggerTrackingForAccount,
  confirmInboundTriggerDelivery,
  getInboundTriggerSnapshot,
  noteInboundTriggerAckAttempt,
} from "./inboundTriggerTracker.js";
import {
  failStreamSession,
  failStreamSessionsForAccount,
  handleInboundMessage,
  type PluginRuntime,
  pauseStreamSessionsForAccount,
  rejectStreamAck,
  resolveStreamAck,
  resumeStreamSessionsForAccount,
} from "./messageHandler.js";
import { TypeOutboundHandler } from "./outbound.js";
import {
  rejectAllPendingSendAcks,
  rejectSendAck,
  resolveSendAck,
} from "./sendAckTracker.js";
import {
  captureEvent,
  captureException,
  initializeTelemetry,
  teardownTelemetry,
} from "./telemetry.js";

const STREAM_ALREADY_ACTIVE_ERROR = "Stream already active for this message";
const TRIGGER_CONFIRMATION_TIMEOUT_MS = 10_000;

export interface StartAccountContext {
  cfg: Record<string, unknown>;
  accountId: string;
  account: { token: string; wsUrl: string };
  runtime: PluginRuntime;
  abortSignal: AbortSignal;
  log?: { info: (msg: string) => void; error: (msg: string) => void };
}

export async function startAccount(ctx: StartAccountContext): Promise<void> {
  const accountId = ctx.accountId;
  const state = getAccountState(accountId);

  if (ctx.abortSignal.aborted) {
    ctx.log?.info(
      `[type] Account "${accountId}" abort signal already fired, skipping startAccount`,
    );
    return;
  }

  if (state.connectionState !== "disconnected") {
    ctx.log?.info(
      `[type] Account "${accountId}" already ${state.connectionState}, skipping duplicate startAccount`,
    );
    return;
  }
  state.connectionState = "connecting";

  let runtime: PluginRuntime;
  let accountConfig: ReturnType<typeof resolveAccount>;
  let token: string;
  let wsUrl: string;
  let agentId: string;
  try {
    runtime = getPluginRuntime() ?? ctx.runtime;
    accountConfig = resolveAccount(ctx.cfg, accountId);
    token = ctx.account.token || accountConfig.token;
    wsUrl = ctx.account.wsUrl || accountConfig.wsUrl;
    agentId = accountConfig.agentId;

    initializeTelemetry({ token, wsUrl, agentId });
  } catch (err) {
    state.connectionState = "disconnected";
    throw err;
  }

  const connection = new TypeConnection({
    token,
    wsUrl,
    onMessage: (event) => {
      if (state.connection !== connection) return;

      if (event.type === "success") {
        const { requestType: reqType, messageId } = event;
        console.log(`[type:${accountId}] Server success: ${reqType}`);
        if (
          messageId &&
          (reqType === "trigger_received" ||
            reqType === "respond" ||
            reqType === "stream_start")
        ) {
          confirmInboundTriggerDelivery(accountId, messageId);
        }
        if (reqType === "stream_start") {
          resolveStreamAck(messageId, accountId);
        }
        if (reqType === "send" && event.requestId) {
          resolveSendAck(accountId, event.requestId, {
            messageId: event.messageId ?? "",
            channelId: event.channelId ?? null,
            parentMessageId: event.parentMessageId ?? null,
            channelName: event.channelName ?? null,
            channelType: event.channelType ?? null,
            chatType: event.chatType ?? null,
            timestamp: event.timestamp ?? null,
          });
        }
        return;
      }
      if (event.type === "error") {
        if (
          event.messageId &&
          (event.requestType === "respond" ||
            event.requestType === "stream_start")
        ) {
          confirmInboundTriggerDelivery(accountId, event.messageId);
        }
        if (
          event.requestType === "stream_start" &&
          event.error === STREAM_ALREADY_ACTIVE_ERROR
        ) {
          resolveStreamAck(event.messageId, accountId);
          return;
        }

        console.error(
          `[type:${accountId}] Server error: ${event.requestType} — ${event.error}`,
          event.details ?? "",
        );
        const error = new Error(event.error ?? "stream request failed");
        captureException(error, {
          properties: {
            source: "server_error",
            requestType: event.requestType,
            messageId: event.messageId,
            details: event.details,
          },
        });
        if (
          event.messageId &&
          (event.requestType === "stream_start" ||
            event.requestType === "stream_event" ||
            event.requestType === "stream_finish" ||
            event.requestType === "stream_heartbeat")
        ) {
          failStreamSession(
            event.messageId,
            event.requestType,
            error,
            accountId,
          );
        }
        if (event.requestType === "stream_start") {
          rejectStreamAck(error, event.messageId, accountId);
        }
        if (event.requestType === "send" && event.requestId) {
          rejectSendAck(accountId, event.requestId, error);
        }
        return;
      }

      if (event.type === "stream_cancel") {
        rejectStreamAck(
          new Error("Cancelled by user"),
          event.messageId,
          accountId,
        );
        failStreamSession(
          event.messageId,
          "stream_event",
          new Error("Cancelled by user"),
          accountId,
        );
        return;
      }

      if (event.type !== "message") return;
      if (!state.outbound) return;

      const trackedTrigger = getInboundTriggerSnapshot(
        accountId,
        event.messageId,
      );
      if (trackedTrigger?.serverAcknowledged) {
        return;
      }

      // sendNow must precede noteInboundTriggerAckAttempt so failed sends cannot mark the tracker dispatched before confirmInboundTriggerDelivery can resolve it.
      const acknowledged = connection.sendNow({
        type: "trigger_received",
        messageId: event.messageId,
        receivedAt: Date.now(),
      });
      if (!acknowledged) {
        console.error(
          `[type:${accountId}] Failed to send trigger_received ack for ${event.messageId}`,
        );
        captureException(new Error("Failed to send trigger_received ack"), {
          properties: { source: "trigger_ack", messageId: event.messageId },
        });
        connection.requestReconnectOnce("trigger_received send failed");
        return;
      }

      const tracking = noteInboundTriggerAckAttempt({
        accountId,
        messageId: event.messageId,
        ackTimeoutMs: TRIGGER_CONFIRMATION_TIMEOUT_MS,
        onAckTimeout: () => {
          if (state.connection !== connection) return;
          if (state.connectionState === "disconnected") return;
          if (
            !connection.requestReconnectOnce(
              "trigger_received confirmation timeout",
            )
          ) {
            return;
          }
          console.warn(
            `[type:${accountId}] trigger_received confirmation timed out for ${event.messageId}; reconnecting`,
          );
          captureEvent("trigger_received_confirmation_timeout", {
            accountId,
            agentId,
            messageId: event.messageId,
          });
        },
      });
      if (!tracking.shouldDispatch) {
        return;
      }

      handleInboundMessage({
        msg: event,
        accountId,
        account: {
          token,
          wsUrl,
          agentId,
          ownerAllowFrom: accountConfig.ownerAllowFrom,
        },
        cfg: ctx.cfg,
        runtime,
        outbound: state.outbound,
        log: ctx.log,
      });
    },
    onConnected: () => {
      if (state.connection !== connection) return;
      state.connectionState = "connected";
      resumeStreamSessionsForAccount(accountId);
      ctx.log?.info(`[type:${accountId}] WebSocket connected`);
      captureEvent("account_connected", { accountId, agentId });
    },
    onDisconnected: (event) => {
      if (state.connection !== connection) return;

      if (event.willReconnect) {
        state.connectionState = "connecting";
        ctx.log?.info(
          `[type:${accountId}] WebSocket disconnected, reconnecting`,
        );
        captureEvent("account_disconnected", {
          accountId,
          agentId,
          code: event.code,
          reason: event.reason,
          willReconnect: true,
        });
        pauseStreamSessionsForAccount(accountId);
        return;
      }

      state.connectionState = "disconnected";
      ctx.log?.info(`[type:${accountId}] WebSocket disconnected`);
      captureEvent("account_disconnected", {
        accountId,
        agentId,
        code: event.code,
        reason: event.reason,
        willReconnect: false,
      });
      failStreamSessionsForAccount(
        accountId,
        new Error(event.reason || "WebSocket disconnected"),
      );
      rejectAllPendingSendAcks(accountId);
    },
  });

  state.connection = connection;
  state.outbound = new TypeOutboundHandler(connection);
  state.context = { token, wsUrl, agentId };

  // Register the abort listener BEFORE connecting to avoid a race where the
  // signal fires between the initial aborted check and listener registration,
  // which would hang startAccount forever.
  const shutdownPromise = new Promise<void>((resolve) => {
    const onAbort = (): void => {
      captureEvent("account_shutdown", { accountId, agentId });
      state.connectionState = "disconnected";
      failStreamSessionsForAccount(accountId, new Error("Account shutdown"));
      rejectAllPendingSendAcks(accountId);
      connection.disconnect();
      teardownTelemetry(agentId);
      state.connection = null;
      state.outbound = null;
      state.context = null;
      clearInboundTriggerTrackingForAccount(accountId);
      clearAccountState(accountId);
      resolve();
    };

    if (ctx.abortSignal.aborted) {
      onAbort();
      return;
    }
    ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
  });

  connection.connect();

  await shutdownPromise;
}
