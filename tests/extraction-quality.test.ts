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
  it('omits recommendation headings while preserving contextual actions', () => {
    for (const heading of ['Which ones I would pursue first', 'What I would ask the team', 'Where I would start', 'Options I would consider']) expect(extract(heading)).toEqual([]);
    for (const recommendation of ['I would pursue the smaller release first.', 'For this release, I would prioritize deletion controls.', 'Given the remaining risks, I would check recovery first.', 'For this release, I would still recommend a local database.']) {
      const items = extract(recommendation);
      expect(items.map(item => item.category)).toEqual(['action']);
      expect(items[0]?.evidence.quote).toBe(recommendation);
    }
  });
  it('recognizes explicit follow-up introductions without scanning inside draft copy', () => {
    for (const question of ['One more question: Is the deadline fixed?', 'One question that would help: Is this already deployed?', 'One last important question: Do you have a backup?']) expect(extract(question).map(item => item.category)).toEqual(['question']);
    for (const draft of ['"One more question: Can you revise the quote?"', '> One last important question: Can you revise the quote?', 'Draft: One question that would help: Can you revise the quote?']) expect(extract(draft)).toEqual([]);
  });
  it('does not turn hypothetical decisions or explicit examples into commitments', () => {
    for (const text of ['If we decided to ship today, what would break?', 'Suppose we decided to use remote storage.', 'Example: We decided to remove all storage.', 'We have not decided to remove local storage.']) expect(extract(text)).toEqual([]);
    expect(extract('We decided not to remove local storage.').map(item => item.category)).toEqual(['decision']);
    expect(extract('If we decided to ship today, what would break?', 'user').map(item => item.category)).toEqual(['question']);
    expect(extract('Have we decided to ship today?', 'user').map(item => item.category)).toEqual(['question']);
    expect(extract('One more question: Have we decided to ship today?').map(item => item.category)).toEqual(['question']);
  });
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
