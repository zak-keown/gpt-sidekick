import { expect, test, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = (label: string) => `<!doctype html><html><head><title>${label} - ChatGPT</title></head><body>
<main>
<article data-turn-id="turn-a"><div data-message-author-role="user" data-message-id="message-a"><div class="whitespace-pre-wrap">Which browser comes first?</div></div></article>
<article data-turn-id="turn-b"><div data-message-author-role="assistant" data-message-id="message-b"><div class="markdown"><p>We decided to use ${label}.</p><p>TODO: verify the source links.</p><button>Copy answer</button></div></div></article>
<article data-turn-id="turn-c"><div data-message-author-role="assistant" data-message-id="message-c"><div class="markdown"><pre><code>const local = true;</code></pre></div></div></article>
</main></body></html>`;

// Structural attributes observed on the authenticated site, 2026-10-18.
// Text and identifiers are synthetic; no real conversation data is stored here.
const modernFixture = (label: string, conversationId: string) => `<!doctype html><html><head><title>${label} - ChatGPT</title></head><body><main>
<div data-turn-key="turn-a"><div data-content-search-turn-key="fallback-turn-0"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="message-a"><div data-user-message-bubble="true">Which browser comes first?</div></div></div></div></div>
<div data-turn-key="turn-b"><div data-content-search-turn-key="fallback-turn-1"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="fallback-turn-1:2:assistant" data-chatgpt-search-message-ids="message-b message-b"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-conversation-id="${conversationId}" data-chatgpt-selection-message-id="message-b"><div data-markdown-text-style="assistant-message"><p>We decided to use ${label}.</p><p>TODO: verify the source links.</p></div></div><button>Copy answer</button></div></div></div></div>
<div data-turn-key="turn-c"><div data-content-search-turn-key="fallback-turn-2"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="fallback-turn-2:2:assistant" data-chatgpt-search-message-ids="message-c"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-conversation-id="${conversationId}" data-chatgpt-selection-message-id="message-c"><div data-markdown-text-style="assistant-message"><pre><code>const local = true;</code></pre></div></div></div></div></div></div>
</main></body></html>`;

for (const layout of ['legacy', 'current'] as const) {
test(`built extension captures, persists, navigates, isolates tabs, and deletes (${layout})`, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sidekick-e2e-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve('dist');
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route('https://chatgpt.com/**', route => {
      const url = new URL(route.request().url());
      const label = url.pathname.includes('second') ? 'Firefox' : 'Chrome';
      return route.fulfill({ contentType: 'text/html', body: layout === 'legacy' ? fixture(label) : modernFixture(label, url.pathname.split('/').at(-1)!) });
    });
    const worker: Worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/first');
    const panel = await context.newPage();
    // Keep polling enabled while the fixture conversation is the active tab.
    await panel.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const activate = async (fragment: string) => {
      await worker.evaluate(async fragment => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find(tab => tab.url?.includes(fragment));
        if (!target?.id) throw new Error('Fixture tab missing');
        await chrome.tabs.update(target.id, { active: true });
      }, fragment);
    };
    await activate('/c/first');
    await expect(panel.getByRole('heading', { name: 'We decided to use Chrome.' })).toBeVisible();
    await expect(panel.getByText('Copy answer', { exact: true })).toHaveCount(0);
    const invoke = async (name: string) => {
      await panel.getByRole('button', { name, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    };
    await invoke('Reindex conversation');
    await expect(panel.getByText(layout === 'legacy' ? 'Outline up to date' : 'History coverage is partial')).toBeVisible();
    await expect(panel.getByText('3 of 3 loaded turns captured')).toBeVisible();
    await panel.getByRole('button', { name: 'View source', exact: true }).first().evaluate(button => (button as HTMLButtonElement).click());
    await expect(chat.locator(layout === 'legacy' ? '[data-message-id="message-b"]' : '[data-chatgpt-selection-message-id="message-b"]')).toHaveCSS('outline-style', 'solid');

    // Reopening the extension page reads saved data without a new DOM mutation.
    await panel.reload();
    await activate('/c/first');
    await expect(panel.getByRole('heading', { name: 'We decided to use Chrome.' })).toBeVisible();

    // A second copy of the same conversation may contain a different revision.
    // It must explicitly take ownership instead of overwriting the first tab.
    const duplicate = await context.newPage();
    await duplicate.goto('https://chatgpt.com/c/first?stale=1');
    await duplicate.locator('.markdown p,[data-markdown-text-style] p').first().evaluate(element => { element.textContent = 'We decided to use another revision.'; });
    await expect(panel.getByRole('alert').filter({ hasText: /another tab/ })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'We decided to use Chrome.' })).toHaveCount(0);
    await invoke('Reindex conversation');
    await expect(panel.getByRole('heading', { name: 'We decided to use another revision.' })).toBeVisible();
    await duplicate.close();
    await activate('/c/first');
    await invoke('Reindex conversation');
    await expect(panel.getByRole('heading', { name: 'We decided to use Chrome.' })).toBeVisible();

    const second = await context.newPage();
    await second.goto('https://chatgpt.com/c/second');
    await expect(panel.getByRole('heading', { name: 'We decided to use Firefox.' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'We decided to use Chrome.' })).toHaveCount(0);

    await invoke('Delete this outline');
    await invoke('Delete this conversation');
    await expect(panel.getByRole('heading', { name: 'Ready to read' })).toBeVisible();
    await second.locator('.markdown p,[data-markdown-text-style] p').first().evaluate(element => { element.textContent = 'We decided to use Safari.'; });
    await panel.waitForTimeout(700);
    await expect(panel.getByRole('heading', { name: 'We decided to use Safari.' })).toHaveCount(0);
    await invoke('Reindex conversation');
    await expect(panel.getByRole('heading', { name: 'We decided to use Safari.' })).toBeVisible();
    await panel.setViewportSize({ width: 360, height: 900 });
    await panel.screenshot({ path: `test-results/sidekick-panel-${layout}.png`, fullPage: true });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
}
