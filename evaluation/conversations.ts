import type { Category, Role, TranscriptMessage } from '../src/core/types';

export interface EvaluationCase {
  name: string;
  messages: TranscriptMessage[];
  expected: { messageId: string; category: Category; quote: string }[];
}

const messages = (conversationId: string, rows: [string, Role, string][]): TranscriptMessage[] => rows.map(([id, role, text], ordinal) => ({ id, role, text, ordinal, conversationId }));

/** Authored synthetic scenarios, never exported from a user's conversation. */
export const conversations: EvaluationCase[] = [
  {
    name: 'Software planning',
    messages: messages('software', [
      ['s1', 'user', 'Should we ship account export before workspace sharing?'],
      ['s2', 'assistant', '## Decision\n## Next steps\nWhich options I would consider\nIf we decided to ship today, what would break?\nExample: We decided to remove all storage.'],
      ['s3', 'assistant', "Decision: ship account export first.\nAction: Maya will implement CSV export by Friday.\nArtifact: docs/export-spec.md\n```ts\nconst format = 'csv';\n```\nOne more question: Is JSON export still required?"],
      ['s4', 'user', 'Correction: the deadline is Monday, not Friday.\nWe have not decided to remove JSON export.\nIf legal approves, we could add workspace sharing later.\nDraft button tooltip: "Would you like to export your account?"'],
    ]),
    expected: [
      { messageId: 's1', category: 'question', quote: 'Should we ship account export before workspace sharing?' },
      { messageId: 's3', category: 'decision', quote: 'Decision: ship account export first.' },
      { messageId: 's3', category: 'action', quote: 'Action: Maya will implement CSV export by Friday.' },
      { messageId: 's3', category: 'artifact', quote: 'Artifact: docs/export-spec.md' },
      { messageId: 's3', category: 'code', quote: "```ts\nconst format = 'csv';\n```" },
      { messageId: 's3', category: 'question', quote: 'One more question: Is JSON export still required?' },
      { messageId: 's4', category: 'correction', quote: 'Correction: the deadline is Monday, not Friday.' },
    ],
  },
  {
    name: 'Research comparison',
    messages: messages('research', [
      ['r1', 'user', 'Which method has lower error on the held-out dataset?'],
      ['r2', 'assistant', 'Note: Method A has 12% error and Method B has 15% error on the same held-out dataset.\nDecision: use Method A for the next replication.\nAction: Priya will rerun both methods with five random seeds.\nArtifact: results/comparison.csv\nOne question that would help: Were both runs seeded identically?'],
      ['r3', 'user', 'Correction: Method B has 11% error after fixing the denominator.\nDo the confidence intervals overlap?'],
      ['r4', 'assistant', 'We have not selected the final method.\nIf the replication agrees, Method B might become the baseline.\nThe proposed survey item is "Which method do you trust more?"\nWhat I would ask the team'],
    ]),
    expected: [
      { messageId: 'r1', category: 'question', quote: 'Which method has lower error on the held-out dataset?' },
      { messageId: 'r2', category: 'note', quote: 'Note: Method A has 12% error and Method B has 15% error on the same held-out dataset.' },
      { messageId: 'r2', category: 'decision', quote: 'Decision: use Method A for the next replication.' },
      { messageId: 'r2', category: 'action', quote: 'Action: Priya will rerun both methods with five random seeds.' },
      { messageId: 'r2', category: 'artifact', quote: 'Artifact: results/comparison.csv' },
      { messageId: 'r2', category: 'question', quote: 'One question that would help: Were both runs seeded identically?' },
      { messageId: 'r3', category: 'correction', quote: 'Correction: Method B has 11% error after fixing the denominator.' },
      { messageId: 'r3', category: 'question', quote: 'Do the confidence intervals overlap?' },
    ],
  },
  {
    name: 'Troubleshooting',
    messages: messages('troubleshooting', [
      ['t1', 'user', 'The worker exits after thirty seconds.\nIs the request timeout causing the restart?'],
      ['t2', 'assistant', 'Note: the restart happens before the first request finishes.\nAction: Sam will capture the worker exit code on the next run.\n```sh\nworker --verbose > worker.log 2>&1\n```\nArtifact: worker.log\nOne last important question: Can you share the exit code?'],
      ['t3', 'user', 'Correction: the process receives SIGTERM; it does not crash.\nDecision: keep the timeout unchanged while we investigate the supervisor.\nWhich supervisor setting sends SIGTERM?'],
      ['t4', 'assistant', 'Do not delete the production database.\nIf the supervisor is responsible, increasing its grace period could help.\nDraft incident title: "Why does the worker restart?"\nWhere I would start'],
    ]),
    expected: [
      { messageId: 't1', category: 'question', quote: 'Is the request timeout causing the restart?' },
      { messageId: 't2', category: 'note', quote: 'Note: the restart happens before the first request finishes.' },
      { messageId: 't2', category: 'action', quote: 'Action: Sam will capture the worker exit code on the next run.' },
      { messageId: 't2', category: 'code', quote: '```sh\nworker --verbose > worker.log 2>&1\n```' },
      { messageId: 't2', category: 'artifact', quote: 'Artifact: worker.log' },
      { messageId: 't2', category: 'question', quote: 'One last important question: Can you share the exit code?' },
      { messageId: 't3', category: 'correction', quote: 'Correction: the process receives SIGTERM; it does not crash.' },
      { messageId: 't3', category: 'decision', quote: 'Decision: keep the timeout unchanged while we investigate the supervisor.' },
      { messageId: 't3', category: 'question', quote: 'Which supervisor setting sends SIGTERM?' },
    ],
  },
];
