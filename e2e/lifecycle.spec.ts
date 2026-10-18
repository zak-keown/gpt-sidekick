import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = `<!doctype html><html><head><title>Lifecycle fixture - ChatGPT</title></head><body>
<div data-app-action-timeline-scroll style="height:400px;overflow-y:auto"><div data-thread-find-target="conversation">
<div data-turn-key="turn-0"><div data-content-search-turn-key="fallback-turn-0"><div data-talvt-turn-state="streaming">
<div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="user-0"><div data-user-message-bubble>Can you prepare the fixture?</div></div>
<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="assistant-0"><div data-chatgpt-selection-conversation-id="lifecycle" data-chatgpt-selection-message-id="assistant-0"><div data-markdown-text-style="assistant-message"><p>We decided to ship the draft.</p></div></div></div>
</div></div></div></div></div></body></html>`;

test('streaming converges, capture resumes after actual worker termination, and deletion stays paused', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(join(tmpdir(), 'sidekick-lifecycle-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve('dist');
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const workerUrl = worker.url();
    const extensionId = new URL(workerUrl).hostname;
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/lifecycle');
    const openPanel = async () => {
      const page = await context!.newPage();
      await page.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await page.evaluate(async () => {
        const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/c/lifecycle'))!;
        await chrome.tabs.update(tab.id!, { active: true });
      });
      return page;
    };
    let panel = await openPanel();
    const invoke = async (name: string) => panel.getByRole('button', { name, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await expect(panel.getByRole('heading', { name: 'We decided to ship the draft.' })).toBeVisible();
    await invoke('Reindex conversation');
    await expect(panel.getByText('History was traversed. Waiting for all captured turns to expose complete content.')).toBeVisible();
    await chat.evaluate(() => {
      document.querySelector('[data-markdown-text-style] p')!.textContent = 'We decided to ship the completed response.';
      document.querySelector('[data-talvt-turn-state]')!.setAttribute('data-talvt-turn-state', 'complete');
    });
    await expect(panel.getByText('Outline up to date')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'We decided to ship the completed response.' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'We decided to ship the draft.' })).toHaveCount(0);
    await chat.locator('[data-content-search-turn-key]').evaluate(element => element.setAttribute('data-content-search-turn-key', 'fallback-turn-1'));
    await expect(panel.getByText('History coverage is partial')).toBeVisible();
    await chat.locator('[data-content-search-turn-key]').evaluate(element => element.setAttribute('data-content-search-turn-key', 'fallback-turn-0'));
    await invoke('Reindex conversation');
    await expect(panel.getByText('Outline up to date')).toBeVisible();

    const session = await context.newCDPSession(chat);
    const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>();
    session.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions) versions.set(version.versionId, version); });
    await session.send('ServiceWorker.enable');
    const runningTarget = async () => (await session.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === workerUrl)?.targetId;
    const stopWorker = async () => {
      await expect.poll(() => [...versions.values()].find(version => version.scriptURL === workerUrl && version.runningStatus === 'running')?.versionId).toBeTruthy();
      const version = [...versions.values()].find(version => version.scriptURL === workerUrl && version.runningStatus === 'running')!;
      const targetId = await runningTarget();
      expect(targetId).toBeTruthy();
      await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      await expect.poll(() => versions.get(version.versionId)?.runningStatus).toBe('stopped');
      await expect.poll(runningTarget).toBeUndefined();
      return targetId;
    };
    await panel.close();
    const markWorker = () => worker.evaluate(() => {
      const value = crypto.randomUUID();
      (globalThis as typeof globalThis & { lifecycleMarker?: string }).lifecycleMarker = value;
      return value;
    });
    const marker = await markWorker();
    await stopWorker();
    // Reopen without any ChatGPT DOM mutation. This state must come from the
    // previously committed IndexedDB snapshot, not a new content capture.
    panel = await openPanel();
    await expect(panel.getByRole('heading', { name: 'We decided to ship the completed response.' })).toBeVisible();
    expect(await worker.evaluate(() => (globalThis as typeof globalThis & { lifecycleMarker?: string }).lifecycleMarker)).toBeUndefined();
    await panel.close();
    const nextMarker = await markWorker();
    await stopWorker();
    await chat.locator('[data-markdown-text-style]').evaluate(element => element.insertAdjacentHTML('beforeend', '<p>TODO: verify capture after worker restart.</p>'));
    await expect.poll(runningTarget).toBeTruthy();
    // Chromium reuses the logical extension target ID across worker runs.
    // A discarded JavaScript global proves this is a fresh execution context.
    expect(await worker.evaluate(() => (globalThis as typeof globalThis & { lifecycleMarker?: string }).lifecycleMarker)).toBeUndefined();
    expect(marker).not.toBe(nextMarker);
    panel = await openPanel();
    await expect(panel.getByRole('heading', { name: 'We decided to ship the completed response.' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'TODO: verify capture after worker restart.' })).toBeVisible();
    await expect(panel.getByText('Outline up to date')).toBeVisible();
    await invoke('Delete this outline');
    await invoke('Delete this conversation');
    await expect(panel.getByRole('heading', { name: 'Ready to read' })).toBeVisible();
    await panel.close();
    await stopWorker();
    // A new content script attempts capture after reload. Durable deletion
    // policy must reject it even though the original provider pause is gone.
    await chat.reload();
    panel = await openPanel();
    await expect(panel.getByRole('heading', { name: 'Ready to read' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'We decided to ship the draft.' })).toHaveCount(0);
    await invoke('Reindex conversation');
    await expect(panel.getByRole('heading', { name: 'We decided to ship the draft.' })).toBeVisible();
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
