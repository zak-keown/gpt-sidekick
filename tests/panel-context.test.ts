import { describe, expect, it } from 'vitest';
import { sourceContext } from '../src/panel/context';
import type { OutlineItem, TranscriptMessage } from '../src/core/types';

const quote = 'We decided to use Chrome.';
const item: OutlineItem = { id: 'i', category: 'decision', title: quote, evidence: { messageId: 'm', quote, start: 0, end: quote.length } };
const source = (text: string): TranscriptMessage => ({ id: 'm', conversationId: 'c', ordinal: 0, role: 'assistant', text });

describe('card source context', () => {
  it('adds the reason from the same paragraph without repeating the decision', () => {
    expect(sourceContext(item, source(`${quote} Its side panel keeps the outline beside the chat.`))).toBe('Its side panel keeps the outline beside the chat.');
  });
  it('omits duplicate text, unrelated paragraphs, and changed source text', () => {
    expect(sourceContext(item, source(quote))).toBe('');
    expect(sourceContext(item, source(`${quote}\nUnrelated topic.`))).toBe('');
    expect(sourceContext(item, source('A different revision.'))).toBe('');
  });
  it('preserves the remainder of a truncated title', () => {
    expect(sourceContext({ ...item, title: 'We decided' }, source(quote))).toBe('to use Chrome.');
  });
});
