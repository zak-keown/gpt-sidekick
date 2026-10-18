import { describe, expect, it } from 'vitest';
import { extractOutline, hasValidEvidence } from '../src/core/extract';
import { applyBatch } from '../src/core/snapshot';
import { conversationIdFromUrl, type CaptureBatch, type TranscriptMessage } from '../src/core/types';

const message = (text: string, id = 'm1'): TranscriptMessage => ({ id, conversationId: 'chat-1', role: 'assistant', text, ordinal: 0 });
const batch = (messages: TranscriptMessage[], extra: Partial<CaptureBatch> = {}): CaptureBatch => ({
  conversationId: 'chat-1', title: 'Build plan', messages, mode: 'passive', phase: 'partial',
  progress: { capturedTurns: 1, totalTurns: 3, unstableMessages: 0 }, runId: 'run1', sequence: 0, ...extra,
});

describe('extractive outline', () => {
  it('grounds decisions, actions, questions, and corrections at exact offsets', () => {
    const records = [message('We decided to use local storage.\nTODO: add deletion controls.\nWhich browser comes first?\nCorrection: the first browser is Chrome.')];
    const { items, droppedCandidates } = extractOutline(records);
    expect(items.map(item => item.category)).toEqual(['decision', 'action', 'question', 'correction']);
    expect(items.every(item => hasValidEvidence(item, records))).toBe(true);
    expect(droppedCandidates).toBe(0);
  });

  it('rejects forged offsets even when the quote occurs elsewhere', () => {
    const records = [message('Prefix. We decided to use local storage.')];
    const item = extractOutline(records).items[0]!;
    expect(hasValidEvidence({ ...item, evidence: { ...item.evidence, start: 0 } }, records)).toBe(false);
    expect(hasValidEvidence({ ...item, title: 'An invented conclusion' }, records)).toBe(false);
    expect(hasValidEvidence({ ...item, evidence: { ...item.evidence, start: -1 } }, records)).toBe(false);
  });

  it('invalidates evidence after a message is edited', () => {
    const records = [message('We decided to ship tomorrow.')];
    const item = extractOutline(records).items[0]!;
    expect(hasValidEvidence(item, [message('We decided to wait.')])).toBe(false);
  });

  it('extracts fenced code once without classifying its contents as questions', () => {
    const records = [message('Code:\n```ts\nconst answer = ok ? 1 : 0;\n```\nTODO: run the example.')];
    const { items } = extractOutline(records);
    expect(items.map(item => item.category)).toEqual(['code', 'action']);
    expect(items[0]?.title).toBe('const answer = ok ? 1 : 0;');
    expect(items.every(item => hasValidEvidence(item, records))).toBe(true);
  });

  it('deduplicates repeated quotations and skips tool output', () => {
    expect(extractOutline([message('We decided to ship.'), message('We decided to ship.', 'm2')]).items).toHaveLength(1);
    expect(extractOutline([{ ...message('We decided to ship.'), role: 'tool' }]).items).toHaveLength(0);
  });

  it('does not turn ordinary prose into a pretend summary', () => {
    expect(extractOutline([message('This explains how the application works.')]).items).toEqual([]);
  });

  it('preserves filenames and decimal points inside evidence', () => {
    const records = [message('Created file architecture.md. We decided to use version 2.5.')];
    const { items } = extractOutline(records);
    expect(items.map(item => item.category)).toEqual(['artifact', 'decision']);
    expect(items[0]?.evidence.quote).toBe('Created file architecture.md.');
    expect(items[1]?.evidence.quote).toBe('We decided to use version 2.5.');
  });
});

describe('snapshot lifecycle', () => {
  it('accumulates partial history and regenerates changed evidence', () => {
    const first = applyBatch(null, batch([message('We decided to ship.')]));
    const second = applyBatch(first, batch([message('We decided to wait.'), message('TODO: review.', 'm2')]));
    expect(second.messages).toHaveLength(2);
    expect(second.items.some(item => item.evidence.quote.includes('ship'))).toBe(false);
    expect(second.items.every(item => hasValidEvidence(item, second.messages))).toBe(true);
  });

  it('replaces obsolete history only after a successful full pass', () => {
    const first = applyBatch(null, batch([message('We decided to ship.')]));
    const partial = applyBatch(first, batch([message('TODO: review.', 'm2')], { mode: 'full' }));
    expect(partial.messages).toHaveLength(2);
    const ready = applyBatch(partial, batch([message('TODO: review.', 'm2')], { mode: 'full', phase: 'ready' }));
    expect(ready.messages.map(value => value.id)).toEqual(['m2']);
  });

  it('never merges messages from another conversation', () => {
    const previous = applyBatch(null, batch([message('We decided to ship.')]));
    const next = applyBatch(previous, { ...batch([{ ...message('TODO: review.', 'm2'), conversationId: 'chat-2' }]), conversationId: 'chat-2' });
    expect(next.messages.map(value => value.id)).toEqual(['m2']);
  });

  it('removes an obsolete message branch when its mounted turn is regenerated', () => {
    const first = applyBatch(null, batch([{ ...message('We decided to ship.'), turnId: 'turn-1' }]));
    const next = applyBatch(first, batch([{ ...message('We decided to wait.', 'replacement'), turnId: 'turn-1' }]));
    expect(next.messages.map(value => value.id)).toEqual(['replacement']);
    expect(next.items.map(value => value.evidence.quote)).toEqual(['We decided to wait.']);
  });
});

it('recognizes only ChatGPT conversation URLs on the exact HTTPS host', () => {
  expect(conversationIdFromUrl('https://chatgpt.com/c/abc-123')).toBe('abc-123');
  for (const url of ['http://chatgpt.com/c/123', 'https://chatgpt.com.evil.test/c/123', 'https://chatgpt.com/', 'garbage']) {
    expect(conversationIdFromUrl(url)).toBeNull();
  }
});
