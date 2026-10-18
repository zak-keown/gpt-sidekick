import { afterEach, expect, it, vi } from 'vitest';
import { createChatGPTProvider, type ChatGPTProvider } from '../src/provider/chatgpt';
import type { CaptureBatch } from '../src/core/types';

const html = (conversation = 'fixture') => `<div data-turn-key="turn-key"><div data-content-search-turn-key="fallback-turn-0"><div data-talvt-turn-state="complete">
<div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="user-id"><div data-user-message-bubble="true">Which browser comes first?</div><button>Copy user</button></div>
<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="assistant-id assistant-id"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-message-id="assistant-id" data-chatgpt-selection-conversation-id="${conversation}"><div data-markdown-text-style="assistant-message"><p>We decided to use Chrome.</p><p>TODO: check source links.</p></div></div><button>Copy assistant</button></div>
</div></div></div>`;
let provider: ChatGPTProvider | undefined;
afterEach(() => { provider?.stop(); provider = undefined; document.body.innerHTML = ''; });

function setup() {
  document.body.innerHTML = html();
  const batches: CaptureBatch[] = [];
  const location = { href: 'https://chatgpt.com/c/fixture' };
  provider = createChatGPTProvider({ document, window: { location, removeEventListener: vi.fn() } as unknown as Window, send: batch => { batches.push(batch); } });
  const capture = async () => { const count = batches.length; provider!.capture(); await vi.waitFor(() => expect(batches).toHaveLength(count + 1)); return batches.at(-1)!; };
  return { capture, location };
}

it('captures current-layout user and assistant IDs without headers, toolbars, or duplicate IDs', async () => {
  const { capture } = setup();
  const batch = await capture();
  expect(batch.messages.map(message => [message.id, message.role])).toEqual([['user-id', 'user'], ['assistant-id', 'assistant']]);
  expect(batch.messages[1]?.text).toContain('We decided to use Chrome.');
  expect(batch.messages[1]?.text).not.toContain('ChatGPT said:');
  expect(batch.messages.some(message => message.text.includes('Copy assistant'))).toBe(false);
  expect(batch.phase).toBe('partial');
  expect(batch.progress).toEqual({ capturedTurns: 1, totalTurns: 1, unstableMessages: 0 });
});

it('rejects a current-layout content boundary backed by distinct ambiguous message IDs', async () => {
  const { capture } = setup();
  document.querySelector('[data-chatgpt-search-unit-key$=assistant]')!.setAttribute('data-chatgpt-search-message-ids', 'assistant-id different-id');
  const batch = await capture();
  expect(batch.messages.map(message => message.id)).toEqual(['user-id']);
  expect(batch.progress.unstableMessages).toBe(1);
});

it('rejects assistant selection content attested to a different conversation', async () => {
  const { capture } = setup();
  document.querySelector('[data-chatgpt-selection-conversation-id]')!.setAttribute('data-chatgpt-selection-conversation-id', 'different-conversation');
  const batch = await capture();
  expect(batch.messages.map(message => message.id)).toEqual(['user-id']);
  expect(batch.progress.unstableMessages).toBe(1);
});

it('verifies the exact current-layout assistant source and rejects subsequent text drift', async () => {
  const { capture } = setup();
  const message = (await capture()).messages.find(message => message.role === 'assistant')!;
  const evidence = { messageId: message.id, quote: message.text, start: 0, end: message.text.length };
  const command = { kind: 'content/jump' as const, conversationId: 'fixture', message, evidence };
  expect(await provider!.command(command)).toEqual({ ok: true });
  expect((document.querySelector('[data-chatgpt-selection-message-id]') as HTMLElement).style.outline).toContain('3px');
  document.querySelector('[data-markdown-text-style] p')!.textContent = 'We decided to wait.';
  expect(await provider!.command(command)).toMatchObject({ ok: false });
});

it('quarantines retained current-layout DOM during navigation and accepts replacement content', async () => {
  const { capture, location } = setup();
  await capture();
  location.href = 'https://chatgpt.com/c/next';
  expect((await capture()).messages).toEqual([]);
  document.body.innerHTML = html('next');
  const next = await capture();
  expect(next.messages).toHaveLength(2);
  expect(next.messages.every(message => message.conversationId === 'next')).toBe(true);
});
