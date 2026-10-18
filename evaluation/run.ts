import { conversations } from './conversations';
import { evaluateOutline } from './outline';

const results = conversations.map(evaluateOutline);
console.log('Synthetic extraction regression set. These scores do not measure real-user usefulness.');
console.table(results.map(({ name, matched, expected, extracted, precision, recall, invalidEvidence }) => ({
  scenario: name, matched, expected, extracted, precision: precision.toFixed(3), recall: recall.toFixed(3), invalidEvidence,
})));
for (const { name, missed, unexpected } of results) if (missed.length || unexpected.length) console.log(JSON.stringify({ name, missed, unexpected }, null, 2));
if (results.some(result => result.missed.length || result.unexpected.length || result.invalidEvidence)) process.exitCode = 1;
