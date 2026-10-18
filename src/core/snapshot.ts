import { extractOutline } from './extract';
import type { CaptureBatch, Snapshot, TranscriptMessage } from './types';

/** Full successful scans replace history; partial/passive scans accumulate it. */
export function applyBatch(previous: Snapshot | null, batch: CaptureBatch): Snapshot {
  const replace = batch.mode === 'full' && batch.phase === 'ready';
  const sameConversation = previous?.conversationId === batch.conversationId;
  const messages = new Map<string, TranscriptMessage>();
  const incoming = batch.messages.filter(message => message.conversationId === batch.conversationId);
  const incomingIds = new Set(incoming.map(message => message.id));
  const mountedTurns = new Set(incoming.map(message => message.turnId).filter((id): id is string => id !== undefined));
  if (sameConversation && !replace) {
    for (const message of previous.messages) {
      // A regenerated turn can use a new message ID. The provider's cumulative
      // batch is authoritative for each readable turn it includes.
      if (message.turnId && mountedTurns.has(message.turnId) && !incomingIds.has(message.id)) continue;
      messages.set(message.id, message);
    }
  }
  for (const message of incoming) messages.set(message.id, message);
  const ordered = [...messages.values()].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const outline = extractOutline(ordered);
  return {
    conversationId: batch.conversationId,
    title: batch.title,
    messages: ordered,
    ...outline,
    phase: batch.phase,
    progress: { ...batch.progress },
    updatedAt: new Date().toISOString(),
    ...(batch.error ? { error: batch.error } : {}),
  };
}
