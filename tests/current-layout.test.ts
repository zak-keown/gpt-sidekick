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

async function indexedStreaming() {
  const second = html().replaceAll('turn-key="turn-key"', 'turn-key="turn-second"').replaceAll('fallback-turn-0', 'fallback-turn-1')
    .replaceAll('user-id', 'user-second').replaceAll('assistant-id', 'assistant-second');
  document.body.innerHTML = `<div data-app-action-timeline-scroll><div data-thread-find-target="conversation">${html().replace('data-talvt-turn-state="complete"', 'data-talvt-turn-state="streaming"')}${second}</div></div>`;
  const scroller = document.querySelector<HTMLElement>('[data-app-action-timeline-scroll]')!;
  Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
  const batches: CaptureBatch[] = [];
  provider = createChatGPTProvider({ document, window: { location: { href: 'https://chatgpt.com/c/fixture' }, removeEventListener: vi.fn() } as unknown as Window,
    send: batch => { batches.push(batch); }, boundaryWaitMs: 0, settleMs: 1 });
  await provider.command({ kind: 'content/reindex' });
  await vi.waitFor(() => expect(batches.at(-1)?.phase).toBe('partial'));
  const capture = async () => { const count = batches.length; provider!.capture(); await vi.waitFor(() => expect(batches).toHaveLength(count + 1)); return batches.at(-1)!; };
  return { batches, capture, first: document.querySelector('[data-turn-key="turn-key"]')! };
}

it('converges a verified streaming sweep and replaces obsolete saved history once', async () => {
  const { batches, capture, first } = await indexedStreaming();
  expect(batches.at(-1)?.progress).toMatchObject({ capturedTurns: 1, totalTurns: 2, coverage: 'traversed' });
  first.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'complete');
  first.querySelector('[data-markdown-text-style] p')!.textContent = 'We decided to ship the finished response.';
  const completed = await capture();
  expect(completed).toMatchObject({ phase: 'ready', mode: 'full', progress: { capturedTurns: 2, totalTurns: 2, coverage: 'traversed' } });
  expect(completed.messages.find(message => message.id === 'assistant-id')?.text).toContain('finished response');
  expect((await capture()).mode).toBe('passive');
});

it('keeps an off-screen unfinished turn pending until it remounts with terminal identified content', async () => {
  const { capture, first } = await indexedStreaming();
  const parent = first.parentElement!;
  first.remove();
  expect(await capture()).toMatchObject({ phase: 'partial', progress: { capturedTurns: 1, totalTurns: 2, coverage: 'traversed' } });
  first.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'unknown');
  parent.prepend(first);
  expect((await capture()).phase).toBe('partial');
  first.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'complete');
  expect((await capture()).phase).toBe('ready');
  first.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'streaming');
  first.querySelector('[data-chatgpt-search-unit-key$=assistant]')!.setAttribute('data-chatgpt-search-message-ids', 'replacement');
  first.querySelector('[data-chatgpt-selection-message-id]')!.setAttribute('data-chatgpt-selection-message-id', 'replacement');
  expect((await capture()).phase).toBe('partial');
  first.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'complete');
  const regenerated = await capture();
  expect(regenerated.phase).toBe('ready');
  expect(regenerated.messages.some(message => message.id === 'assistant-id')).toBe(false);
});

it('blocks convergence during history loading and invalidates coverage for new turn identities', async () => {
  const { capture, first } = await indexedStreaming();
  first.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'complete');
  const scope = document.querySelector('[data-thread-find-target]')!;
  scope.insertAdjacentHTML('beforeend', '<div role="status">Loading older messages</div>');
  expect((await capture()).phase).toBe('partial');
  scope.querySelector('[role=status]')!.remove();
  expect((await capture()).phase).toBe('ready');
  document.querySelector('[data-turn-key="turn-second"]')!.setAttribute('data-turn-key', 'different-turn');
  expect((await capture()).phase).toBe('partial');
  document.querySelector('[data-turn-key="different-turn"]')!.setAttribute('data-turn-key', 'turn-second');
  expect((await capture()).phase).toBe('partial');
});

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

it('verifies a terminal cancelled turn with only identified user content', async () => {
  document.body.innerHTML = `<div data-app-action-timeline-scroll><div data-thread-find-target="conversation">${html().replace('data-talvt-turn-state="complete"', 'data-talvt-turn-state="cancelled"')}</div></div>`;
  document.querySelector('[data-chatgpt-search-unit-key$=assistant]')!.remove();
  const scroller = document.querySelector<HTMLElement>('[data-app-action-timeline-scroll]')!;
  Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 100 } });
  const batches: CaptureBatch[] = [];
  provider = createChatGPTProvider({ document, window: { location: { href: 'https://chatgpt.com/c/fixture' }, removeEventListener: vi.fn() } as unknown as Window,
    send: batch => { batches.push(batch); }, boundaryWaitMs: 0, settleMs: 1 });
  expect(await provider.command({ kind: 'content/reindex' })).toEqual({ ok: true });
  await vi.waitFor(() => expect(batches.at(-1)?.phase).toBe('ready'));
  expect(batches.at(-1)?.messages.map(message => message.id)).toEqual(['user-id']);
  expect(batches.at(-1)?.progress).toMatchObject({ capturedTurns: 1, totalTurns: 1, coverage: 'traversed' });
});

it('restores the original unmounted reading position after a limited scan prepends history', async () => {
  document.body.innerHTML = `<div data-app-action-timeline-scroll>${html()}</div>`;
  const scroller = document.querySelector<HTMLElement>('[data-app-action-timeline-scroll]')!;
  const initialTurn = document.querySelector('[data-turn-key]')!;
  initialTurn.getBoundingClientRect = () => ({ top: 100, bottom: 900 } as DOMRect);
  let top = 500;
  let height = 1000;
  let prepended = false;
  Object.defineProperties(scroller, {
    clientHeight: { value: 100 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => {
      top = value;
      if (value === 0 && !prepended) {
        prepended = true; height += 500;
        scroller.innerHTML = html().replace('data-turn-key="turn-key"', 'data-turn-key="older-turn"').replaceAll('user-id', 'older-user').replaceAll('assistant-id', 'older-assistant');
      }
    } },
  });
  const batches: CaptureBatch[] = [];
  provider = createChatGPTProvider({ document, window: { location: { href: 'https://chatgpt.com/c/fixture' }, removeEventListener: vi.fn() } as unknown as Window,
    send: batch => { batches.push(batch); }, boundaryWaitMs: 0, settleMs: 1, maxTurns: 2 });
  await provider.command({ kind: 'content/reindex' });
  await vi.waitFor(() => expect(batches.at(-1)?.phase).toBe('partial'));
  expect(prepended).toBe(true);
  expect(top).toBe(1000);
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

it('waits for remounted content to hydrate but still requires the exact saved text', async () => {
  const { capture } = setup();
  const message = (await capture()).messages.find(message => message.role === 'assistant')!;
  const content = document.querySelector('[data-markdown-text-style]')!;
  const original = content.innerHTML;
  content.innerHTML = '<p>Loading content</p>';
  setTimeout(() => { content.innerHTML = original; }, 30);
  expect(await provider!.command({ kind: 'content/jump', conversationId: 'fixture', message,
    evidence: { messageId: message.id, quote: message.text, start: 0, end: message.text.length } })).toEqual({ ok: true });
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
