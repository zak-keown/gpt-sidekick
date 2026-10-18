import { describe, expect, it } from 'vitest';
import { extractOutline, hasValidEvidence } from '../src/core/extract';
import type { TranscriptMessage } from '../src/core/types';

function extract(text: string, role: TranscriptMessage['role'] = 'assistant') {
  const messages: TranscriptMessage[] = [{ id: 'm1', conversationId: 'chat-1', role, text, ordinal: 0 }];
  const result = extractOutline(messages);
  for (const item of result.items) {
    expect(hasValidEvidence(item, messages)).toBe(true);
    expect(text.includes(item.title)).toBe(true);
    expect(text.slice(item.evidence.start, item.evidence.end)).toBe(item.evidence.quote);
  }
  return result.items;
}

describe('conservative role-aware extraction', () => {
  it('retains user questions and explicit assistant follow-ups', () => {
    expect(extract('What would this cost?', 'user').map(item => item.category)).toEqual(['question']);
    for (const question of ['One question: Is the loan fixed-rate?', 'One quick clarification: Is that your current balance?',
      'Can you clarify the repayment term?', 'Could you share the current interest rate?', 'Do you have a written offer?', 'Are you planning to move soon?']) {
      expect(extract(question).map(item => item.category)).toEqual(['question']);
    }
  });
  it('omits assistant headings and embedded draft questions', () => {
    for (const question of ['How does refinancing work?', 'What would a lower rate mean?', 'Can your lending department provide a revised quote?']) expect(extract(question)).toEqual([]);
    expect(extract('Dear loan officer,\nCan your lending department provide a revised quote?\nThank you.')).toEqual([]);
  });
  it('retains recommendations without inventing commitments', () => {
    for (const suggestion of ['I would recommend getting a written quote.', 'I would suggest comparing the total fees.', 'I would pursue a second opinion.', 'I would compare the two offers.', 'I would check the prepayment penalty.']) {
      const items = extract(suggestion);
      expect(items.map(item => item.category)).toEqual(['action']);
      expect(items[0]?.evidence.quote).toBe(suggestion);
    }
    expect(extract('I am considering refinancing.', 'user')).toEqual([]);
    expect(extract('I would compare the offers.', 'user')).toEqual([]);
  });
  it('captures direct next steps and user clarifications', () => {
    for (const step of ['Confirm the current balance.', 'Ask the lender for a fee schedule.', 'Compare the annual rates.', 'Verify the repayment term.', 'Get a written estimate.']) expect(extract(step).map(item => item.category)).toEqual(['action']);
    for (const clarification of ['To be clear: I plan to stay in the house.', 'To clarify: the balance is before fees.']) {
      expect(extract(clarification, 'user').map(item => item.category)).toEqual(['correction']);
      expect(extract(clarification)).toEqual([]);
    }
  });
});
