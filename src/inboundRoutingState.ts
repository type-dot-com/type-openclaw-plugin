import { AsyncLocalStorage } from "node:async_hooks";

export interface InboundRoutingContext {
  channelId: string;
  replyTargetParentMessageId: string | null;
  requiresExplicitReplyTarget: boolean;
}

const routingStorage = new AsyncLocalStorage<InboundRoutingContext>();

export function runWithInboundRoutingContext<T>(
  context: InboundRoutingContext,
  fn: () => T,
): T {
  return routingStorage.run(context, fn);
}

export function getInboundRoutingContext(): InboundRoutingContext | undefined {
  return routingStorage.getStore();
}

const MISSING_EXPLICIT_REPLY_TARGET_ERROR =
  "Explicit reply target is required for this Type conversation";

export function resolveParentMessageIdForSend(params: {
  channelId: string;
  replyToId?: string;
}): { ok: true; parentMessageId?: string } | { ok: false; error: string } {
  // Prefer the inbound routing context — it carries the real thread root
  // from the server. OpenClaw's replyToId points to the bot's own streaming
  // message which may not exist yet, causing FK violations.
  const inboundRoutingContext = getInboundRoutingContext();
  if (inboundRoutingContext?.channelId === params.channelId) {
    if (inboundRoutingContext.replyTargetParentMessageId) {
      return {
        ok: true,
        parentMessageId: inboundRoutingContext.replyTargetParentMessageId,
      };
    }
    if (inboundRoutingContext.requiresExplicitReplyTarget) {
      return { ok: false, error: MISSING_EXPLICIT_REPLY_TARGET_ERROR };
    }
  }

  // Fall back to OpenClaw's replyToId for proactive sends outside
  // an inbound dispatch context.
  if (params.replyToId) {
    return { ok: true, parentMessageId: params.replyToId };
  }

  return { ok: true, parentMessageId: undefined };
}
