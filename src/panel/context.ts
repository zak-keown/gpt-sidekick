import type { OutlineItem, TranscriptMessage } from '../core/types';

/** Show additional source wording, never an inferred explanation. */
export function sourceContext(item: OutlineItem, message?: TranscriptMessage): string {
  const { quote, start, end } = item.evidence;
  const continuation = quote.startsWith(item.title) ? quote.slice(item.title.length).trim() : quote;
  if (continuation) return continuation.length > 240 ? `${continuation.slice(0, 240)}…` : continuation;
  if (!message || message.text.slice(start, end) !== quote) return '';
  // Stay inside the same paragraph so unrelated messages and code stay separate.
  const after = message.text.slice(end).split('\n')[0]!.trim();
  const before = message.text.slice(0, start).split('\n').at(-1)!.trim();
  const context = after || before;
  return context.length > 240 ? `${context.slice(0, 240)}…` : context;
}
