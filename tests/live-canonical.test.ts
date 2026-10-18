import { expect, it } from 'vitest';
import { canonicalMessageText } from '../src/provider/chatgpt';
import { extractOutline } from '../src/core/extract';

it('keeps paragraph boundaries in whitespace-preserving assistant widgets', () => {
  const selection = document.createElement('div');
  selection.innerHTML = '<div data-markdown-text-style="assistant-message"><div style="white-space: pre-line"><p>Some context.</p><h2>Which source comes first?</h2><p>We decided to use the original.</p><pre><code>const value = 1;\n  keepIndent();</code></pre></div></div>';
  document.body.append(selection);
  const text = canonicalMessageText(selection);
  expect(text).toContain('\nWhich source comes first?\n');
  expect(text).toContain('```\nconst value = 1;\n  keepIndent();\n```');
  expect(extractOutline([{ id: 'synthetic', conversationId: 'synthetic', role: 'assistant', ordinal: 0, text }]).items.map(item => item.category)).toEqual(['question', 'decision', 'code']);
  selection.remove();
});
