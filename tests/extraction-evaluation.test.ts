import { expect, it } from 'vitest';
import { conversations } from '../evaluation/conversations';
import { evaluateOutline } from '../evaluation/outline';

for (const scenario of conversations) {
  it(`matches the authored synthetic ${scenario.name.toLowerCase()} outline with exact evidence`, () => {
    // Validate the authored answer key independently of the extraction rules.
    for (const expected of scenario.expected) expect(scenario.messages.find(message => message.id === expected.messageId)?.text).toContain(expected.quote);
    const result = evaluateOutline(scenario);
    expect(result.invalidEvidence).toBe(0);
    expect(result.missed).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });
}
