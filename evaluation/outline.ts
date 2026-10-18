import { extractOutline } from '../src/core/extract';
import type { EvaluationCase } from './conversations';

export function evaluateOutline(scenario: EvaluationCase) {
  const { items } = extractOutline(scenario.messages);
  const key = (value: { messageId: string; category: string; quote: string }) => JSON.stringify([value.messageId, value.category, value.quote]);
  const actual = items.map(item => ({ messageId: item.evidence.messageId, category: item.category, quote: item.evidence.quote }));
  const actualKeys = new Set(actual.map(key));
  const expectedKeys = new Set(scenario.expected.map(key));
  const missed = scenario.expected.filter(item => !actualKeys.has(key(item)));
  const unexpected = actual.filter(item => !expectedKeys.has(key(item)));
  const matched = scenario.expected.length - missed.length;
  return {
    name: scenario.name, expected: scenario.expected.length, extracted: actual.length, matched,
    precision: actual.length ? matched / actual.length : scenario.expected.length ? 0 : 1,
    recall: scenario.expected.length ? matched / scenario.expected.length : 1,
    // Check the exported evidence contract independently of the extractor's
    // own validation helper, so a regression in that helper is visible here.
    invalidEvidence: items.filter(({ evidence, title }) => {
      const source = scenario.messages.find(message => message.id === evidence.messageId);
      return !source || !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) || evidence.start < 0 ||
        evidence.end <= evidence.start || evidence.end > source.text.length ||
        source.text.slice(evidence.start, evidence.end) !== evidence.quote || !evidence.quote.includes(title);
    }).length,
    missed, unexpected,
  };
}
