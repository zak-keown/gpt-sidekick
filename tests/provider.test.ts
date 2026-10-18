import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalMessageText, createChatGPTProvider, type ChatGPTProvider } from '../src/provider/chatgpt';
import type { CaptureBatch, ContentCommand } from '../src/core/types';

let providers: ChatGPTProvider[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.title = 'Test conversation - ChatGPT';
});
afterEach(() => {
  providers.forEach(provider => provider.stop());
  providers = [];
  vi.useRealTimers();
});

function turn(id: string, text: string, messageId = `message-${id}`): string {
  return `<article data-turn-id="${id}"><div data-message-author-role="assistant" data-message-id="${messageId}"><div class="markdown">${text}</div></div></article>`;
}

function setup(extra = {}) {
  const batches: CaptureBatch[] = [];
  const location = { href: 'https://chatgpt.com/c/conversation-a' };
  const scrollTo = vi.fn();
  const provider = createChatGPTProvider({
    document,
    window: {
      location, scrollX: 0, scrollY: 50, scrollTo,
      MutationObserver,
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
    } as unknown as Window,
    send: batch => { batches.push(batch); },
    settleMs: 10,
    debounceMs: 5,
    ...extra,
  });
  providers.push(provider);
  return { provider, batches, location, scrollTo };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(150);
}

describe('ChatGPT provider', () => {
  it('cancels queued indexing and preserves completed coverage when cancellation arrives late', async () => {
    document.body.innerHTML = turn('one', 'We decided to ship.');
    const { provider, batches, scrollTo } = setup();
    await provider.command({ kind: 'content/reindex' });
    expect(await provider.command({ kind: 'content/cancel' })).toEqual({ ok: true });
    await flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ phase: 'partial', sequence: 1, error: 'Indexing stopped. Captured sources are retained.' });
    expect(scrollTo).not.toHaveBeenCalled();
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    const count = batches.length;
    await provider.command({ kind: 'content/cancel' });
    await flush();
    expect(batches).toHaveLength(count + 1);
    expect(batches.at(-1)).toMatchObject({ phase: 'ready', mode: 'full' });
    provider.capture();
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
  });

  it('recovers a lost completion update when a stale panel asks to stop an already finished scan', async () => {
    document.body.innerHTML = turn('one', 'We decided to ship.');
    let deliverCompletion = false;
    const delivered: CaptureBatch[] = [];
    const { provider } = setup({ send: (batch: CaptureBatch) => {
      if (batch.phase === 'ready' && !deliverCompletion) return Promise.reject(new Error('Worker disconnected'));
      delivered.push(batch);
    } });
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(delivered.at(-1)?.phase).toBe('capturing');
    deliverCompletion = true;
    await provider.command({ kind: 'content/cancel' });
    await flush();
    expect(delivered.at(-1)).toMatchObject({ phase: 'ready', mode: 'full' });
    expect(delivered.at(-1)?.messages[0]?.text).toBe('We decided to ship.');
  });

  it('retains captured progress and prevents an old cancelled scan from restoring over a newer scan', async () => {
    document.body.innerHTML = `<div id="scroller">${turn('one', 'We decided to ship.')}<article data-turn-id="two"></article></div>`;
    const scroller = document.getElementById('scroller')!;
    scroller.scrollTop = 80;
    const second = document.querySelector('[data-turn-id="two"]')!;
    Object.assign(second, { scrollIntoView: () => {
      scroller.scrollTop = 500;
      setTimeout(() => { second.innerHTML = '<div data-message-author-role="user" data-message-id="later"><div data-message-content>Which source is next?</div></div>'; }, 5);
    } });
    const { provider, batches } = setup({ settleMs: 20 });
    await provider.command({ kind: 'content/reindex' });
    await vi.advanceTimersByTimeAsync(1);
    expect(scroller.scrollTop).toBe(500);
    const oldRun = batches.at(-1)!.runId;
    await provider.command({ kind: 'content/cancel' });
    await vi.advanceTimersByTimeAsync(0);
    expect(scroller.scrollTop).toBe(80);
    expect(batches.at(-1)).toMatchObject({ phase: 'partial', runId: oldRun, progress: { capturedTurns: 1, totalTurns: 2 } });
    expect(batches.at(-1)?.messages[0]?.text).toBe('We decided to ship.');
    const stoppedAt = batches.length;
    await provider.command({ kind: 'content/reindex' });
    await vi.advanceTimersByTimeAsync(19);
    expect(scroller.scrollTop).toBe(500);
    await flush();
    expect(batches.slice(stoppedAt).some(batch => batch.runId === oldRun)).toBe(false);
    expect(batches.at(-1)?.phase).toBe('ready');
    expect(scroller.scrollTop).toBe(80);
  });

  it('does not resume capture after deletion when indexing is cancelled', async () => {
    document.body.innerHTML = turn('one', 'Private source');
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reset' });
    await provider.command({ kind: 'content/cancel' });
    provider.capture();
    await flush();
    expect(batches).toEqual([]);
  });

  it('captures canonical content with stable IDs, preserving fenced code and excluding controls', async () => {
    document.body.innerHTML = turn('one', '<p>We decided to ship.</p><div><div>python<button>Copy code</button></div><pre><code>if True:\n  ship()\n\n  done()</code></pre></div><button>Good response</button><span hidden>Hidden</span>');
    const { provider, batches } = setup();
    provider.capture();
    await flush();
    const message = batches[0]?.messages[0];
    expect(message).toMatchObject({ id: 'message-one', conversationId: 'conversation-a', ordinal: 0, turnId: 'one', role: 'assistant' });
    expect(message?.text).toContain('```\nif True:\n  ship()\n\n  done()\n```');
    expect(message?.text).not.toMatch(/Copy code|Good response|Hidden|python/);
    expect(batches[0]?.phase).toBe('partial');
  });

  it('never invents message IDs and reports missing IDs honestly', async () => {
    document.body.innerHTML = '<article data-turn-id="one"><div data-message-author-role="user">Missing ID</div></article>';
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await flush();
    const final = batches.at(-1);
    expect(final?.messages).toEqual([]);
    expect(final?.phase).toBe('partial');
    expect(final?.progress).toEqual({ capturedTurns: 0, totalTurns: 1, unstableMessages: 1 });
  });

  it('acknowledges indexing before work and sends cumulative monotonic batches', async () => {
    document.body.innerHTML = turn('one', 'First') + turn('two', 'Second');
    const { provider, batches, scrollTo } = setup();
    expect(await provider.command({ kind: 'content/reindex' })).toEqual({ ok: true });
    expect(batches).toEqual([]);
    await flush();
    expect(batches.map(batch => batch.messages.length)).toEqual([0, 1, 2, 2]);
    expect(batches.map(batch => batch.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(batches.map(batch => batch.runId)).size).toBe(1);
    expect(batches.at(-1)?.phase).toBe('ready');
    expect(scrollTo).toHaveBeenCalledWith(0, 50);
  });

  it('rehydrates empty persistent wrappers and restores the scroll container', async () => {
    document.body.innerHTML = '<div id="scroller"><article data-turn-id="one"></article></div>';
    const scroller = document.getElementById('scroller')!;
    scroller.scrollTop = 80;
    const wrapper = document.querySelector('[data-turn-id]')!;
    Object.assign(wrapper, { scrollIntoView: () => {
      scroller.scrollTop = 500;
      setTimeout(() => { wrapper.innerHTML = '<div data-message-author-role="user" data-message-id="real"><div data-message-content>Loaded source</div></div>'; }, 5);
    } });
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    expect(batches.at(-1)?.messages[0]?.text).toBe('Loaded source');
    expect(scroller.scrollTop).toBe(80);
  });

  it('bounds full indexing and reports unavailable wrappers as partial', async () => {
    document.body.innerHTML = turn('one', 'First') + '<article data-turn-id="two"></article>';
    const { provider, batches } = setup({ maxTurns: 1 });
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('partial');
    expect(batches.at(-1)?.error).toContain('safety limit');
    expect(batches.at(-1)?.progress).toMatchObject({ capturedTurns: 1, totalTurns: 2 });
  });

  it('cancels a scan on SPA navigation and never scrolls the new conversation', async () => {
    document.body.innerHTML = '<article data-turn-id="one"></article>';
    const { provider, batches, location, scrollTo } = setup();
    await provider.command({ kind: 'content/reindex' });
    await vi.advanceTimersByTimeAsync(1);
    location.href = 'https://chatgpt.com/c/conversation-b';
    await flush();
    expect(batches.some(batch => batch.phase === 'ready')).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    document.body.innerHTML = turn('new', 'New conversation');
    provider.capture();
    await flush();
    expect(batches.at(-1)?.conversationId).toBe('conversation-b');
    expect(batches.at(-1)?.messages.map(message => message.id)).toEqual(['message-new']);
    expect(batches.at(-1)?.sequence).toBe(1);
  });

  it('quarantines retained old DOM after SPA navigation until durable nodes change', async () => {
    document.body.innerHTML = turn('old', 'Private old conversation');
    const { provider, batches, location } = setup();
    provider.capture();
    await flush();
    location.href = 'https://chatgpt.com/c/conversation-b';
    provider.capture();
    await flush();
    expect(batches.at(-1)?.conversationId).toBe('conversation-b');
    expect(batches.at(-1)?.messages).toEqual([]);
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.messages).toEqual([]);
    expect(batches.at(-1)?.phase).toBe('partial');
    document.body.innerHTML = turn('new', 'New conversation source');
    provider.capture();
    await flush();
    expect(batches.at(-1)?.messages.map(message => message.text)).toEqual(['New conversation source']);
  });

  it('accepts new DOM when route and nodes change synchronously before navigation detection', async () => {
    document.body.innerHTML = turn('old', 'Old conversation source');
    const { provider, batches, location } = setup();
    provider.capture();
    await flush();
    // React can commit the new route DOM and pushState in one task, before
    // either the mutation observer or our navigation interval executes.
    document.body.innerHTML = turn('new', 'New conversation source');
    location.href = 'https://chatgpt.com/c/conversation-b';
    provider.capture();
    await flush();
    expect(batches.at(-1)?.conversationId).toBe('conversation-b');
    expect(batches.at(-1)?.messages.map(message => message.text)).toEqual(['New conversation source']);
    // Consecutive transitions must remember B's nodes too.
    location.href = 'https://chatgpt.com/c/conversation-c';
    provider.capture();
    await flush();
    expect(batches.at(-1)?.messages).toEqual([]);
  });

  it('refreshes an early streaming message before declaring a long scan ready', async () => {
    document.body.innerHTML = turn('one', 'Partial streaming text') + '<article data-turn-id="two"></article>';
    document.querySelector('[data-message-id]')!.setAttribute('data-is-streaming', 'true');
    const second = document.querySelector('[data-turn-id="two"]')!;
    Object.assign(second, { scrollIntoView: () => {
      setTimeout(() => {
        document.querySelector('.markdown')!.textContent = 'Final streaming text';
        document.querySelector('[data-message-id]')!.removeAttribute('data-is-streaming');
        second.innerHTML = '<div data-message-author-role="user" data-message-id="real"><div data-message-content>Loaded later source</div></div>';
      }, 5);
    } });
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    expect(batches.at(-1)?.messages[0]?.text).toBe('Final streaming text');
  });

  it('reset cancels queued and running work and pauses passive capture until explicit indexing', async () => {
    document.body.innerHTML = turn('one', 'Private source');
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await provider.command({ kind: 'content/reset' });
    provider.capture();
    await flush();
    expect(batches).toEqual([]);
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
  });

  it('restores an interrupted scan immediately on privacy reset', async () => {
    document.body.innerHTML = '<div id="scroller"><article data-turn-id="one"></article></div>';
    const scroller = document.getElementById('scroller')!;
    scroller.scrollTop = 80;
    Object.assign(document.querySelector('[data-turn-id]')!, { scrollIntoView: () => { scroller.scrollTop = 500; } });
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await vi.advanceTimersByTimeAsync(1);
    expect(scroller.scrollTop).toBe(500);
    await provider.command({ kind: 'content/reset' });
    expect(scroller.scrollTop).toBe(80);
    const count = batches.length;
    await flush();
    expect(batches).toHaveLength(count);
  });

  it('verifies exact canonical evidence before highlighting a source', async () => {
    document.body.innerHTML = turn('one', '<p>Decision: ship today.</p>');
    const { provider, batches } = setup();
    provider.capture();
    await flush();
    const message = batches[0]!.messages[0]!;
    const command: ContentCommand = { kind: 'content/jump', conversationId: message.conversationId, message, evidence: { messageId: message.id, quote: 'ship today', start: 10, end: 20 } };
    expect(await provider.command(command)).toEqual({ ok: true });
    const element = document.querySelector<HTMLElement>('[data-message-id]')!;
    expect(element.style.outline).toContain('3px');
    element.style.outline = '';
    element.querySelector('.markdown')!.textContent = 'Decision: no longer shipping.';
    expect(await provider.command(command)).toMatchObject({ ok: false });
    expect(element.style.outline).toBe('');
    expect(await provider.command({ ...command, conversationId: 'another' })).toMatchObject({ ok: false });
  });

  it('debounces passive observer capture without scrolling', async () => {
    const { provider, batches, scrollTo } = setup();
    provider.start();
    document.body.innerHTML = turn('one', 'Streaming');
    document.querySelector('.markdown')!.textContent = 'Streaming complete';
    await vi.advanceTimersByTimeAsync(20);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.messages[0]?.text).toBe('Streaming complete');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('preserves full coverage on passive updates and completes after streaming ends', async () => {
    document.body.innerHTML = turn('one', 'Initial text');
    const element = document.querySelector('[data-message-id]')!;
    element.setAttribute('data-is-streaming', 'true');
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('partial');
    expect(batches.at(-1)?.error).toContain('streaming');
    element.removeAttribute('data-is-streaming');
    element.querySelector('.markdown')!.textContent = 'Final text';
    provider.capture();
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    expect(batches.at(-1)?.messages[0]?.text).toBe('Final text');
    provider.capture();
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    document.body.insertAdjacentHTML('beforeend', turn('two', 'New turn'));
    provider.capture();
    await flush();
    expect(batches.at(-1)?.phase).toBe('partial');
  });

  it('preserves cumulative full coverage after previously captured turns virtualize again', async () => {
    document.body.innerHTML = turn('one', 'First source') + turn('two', 'Second source') + turn('three', 'Third source');
    const { provider, batches } = setup();
    await provider.command({ kind: 'content/reindex' });
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    document.querySelector('[data-turn-id="one"]')!.innerHTML = '';
    document.querySelector('[data-turn-id="two"]')!.innerHTML = '';
    provider.capture();
    await flush();
    expect(batches.at(-1)?.phase).toBe('ready');
    expect(batches.at(-1)?.progress).toEqual({ capturedTurns: 3, totalTurns: 3, unstableMessages: 0 });
    expect(batches.at(-1)?.messages).toHaveLength(3);
    document.querySelector('[data-turn-id="two"]')!.innerHTML = '<div data-message-author-role="assistant">Unstable new message</div>';
    provider.capture();
    await flush();
    expect(batches.at(-1)?.phase).toBe('partial');
    expect(batches.at(-1)?.progress.capturedTurns).toBe(2);
  });

  it('rejects an unavailable source and rehydrates a known source by persistent turn ID', async () => {
    document.body.innerHTML = turn('one', 'Decision: ship today.');
    const { provider, batches } = setup();
    provider.capture();
    await flush();
    const message = batches[0]!.messages[0]!;
    const command: ContentCommand = { kind: 'content/jump', conversationId: message.conversationId, message, evidence: { messageId: message.id, quote: 'ship today', start: 10, end: 20 } };
    const wrapper = document.querySelector('[data-turn-id]')!;
    wrapper.innerHTML = '';
    const missing = provider.command(command);
    await flush();
    expect(await missing).toMatchObject({ ok: false });
    Object.assign(wrapper, { scrollIntoView: () => {
      setTimeout(() => { wrapper.innerHTML = '<div data-message-author-role="assistant" data-message-id="message-one"><div class="markdown">Decision: ship today.</div></div>'; }, 5);
    } });
    const jumping = provider.command(command);
    await flush();
    expect(await jumping).toEqual({ ok: true });
  });

  it('uses the same canonical serializer for source evidence', () => {
    document.body.innerHTML = turn('one', '<p>Hello <em>there</em>.</p><p>Second line.</p>');
    expect(canonicalMessageText(document.querySelector('[data-message-id]')!)).toContain('Hello there.');
  });

  it('restores the original highlight after repeated jumps and reset', async () => {
    document.body.innerHTML = turn('one', 'Decision: ship today.');
    const { provider, batches } = setup();
    provider.capture();
    await flush();
    const message = batches[0]!.messages[0]!;
    const element = document.querySelector<HTMLElement>('[data-message-id]')!;
    element.style.outline = '1px dotted red';
    const command: ContentCommand = { kind: 'content/jump', conversationId: message.conversationId, message, evidence: { messageId: message.id, quote: 'ship today', start: 10, end: 20 } };
    await provider.command(command);
    await vi.advanceTimersByTimeAsync(1000);
    await provider.command(command);
    await vi.advanceTimersByTimeAsync(1000);
    expect(element.style.outline).toContain('3px');
    await vi.advanceTimersByTimeAsync(900);
    expect(element.style.outline).toBe('1px dotted red');
    await provider.command(command);
    await provider.command({ kind: 'content/reset' });
    expect(element.style.outline).toBe('1px dotted red');
  });
});
