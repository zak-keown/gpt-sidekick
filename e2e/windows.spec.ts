import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = (id: string) => `<!doctype html><html><head><title>${id} - ChatGPT</title></head><body>
<div data-turn-key="turn-${id}"><div data-content-search-turn-key="fallback-turn-0"><div data-talvt-turn-state="complete">
<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="message-${id}"><div data-chatgpt-selection-conversation-id="${id}" data-chatgpt-selection-message-id="message-${id}"><div data-markdown-text-style="assistant-message"><p>We decided to use ${id}.</p></div></div></div>
</div></div></div></body></html>`;

test('each panel keeps its own window conversation and source target across tab changes', async () => {
  test.setTimeout(45_000);
  const profile = await mkdtemp(join(tmpdir(), 'sidekick-windows-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve('dist');
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    await context.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
    await context.route('https://chatgpt.com/**', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
      return route.fulfill({ contentType: 'text/html', body: fixture(id) });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const panelUrl = `chrome-extension://${new URL(worker.url()).hostname}/sidepanel.html`;
    const panelOne = await context.newPage();
    await panelOne.goto(panelUrl);
    const windowOne = await panelOne.evaluate(async () => (await chrome.windows.getCurrent()).id!);
    const firstPage = context.waitForEvent('page');
    const tabOne = await panelOne.evaluate(async windowId => (await chrome.tabs.create({ windowId, url: 'about:blank', active: true })).id!, windowOne);
    const chatOne = await firstPage;
    // Attach Playwright before navigation so the fixture route intercepts
    // requests from tabs created through Chrome's extension APIs as well.
    await chatOne.goto('https://chatgpt.com/c/window-one');
    await expect(chatOne.locator('[data-turn-key]')).toHaveCount(1);

    const secondPage = context.waitForEvent('page');
    const windowTwo = await panelOne.evaluate(async () => {
      const created = await chrome.windows.create({ url: 'about:blank', focused: false });
      if (created?.id === undefined || created.tabs?.[0]?.id === undefined) throw new Error('Second fixture window was not created');
      return { id: created.id!, tabId: created.tabs![0]!.id! };
    });
    const chatTwo = await secondPage;
    await chatTwo.goto('https://chatgpt.com/c/window-two');
    await expect(chatTwo.locator('[data-turn-key]')).toHaveCount(1);
    const secondPanel = context.waitForEvent('page');
    await panelOne.evaluate(async ({ windowId, url }) => { await chrome.tabs.create({ windowId, url, active: false }); }, { windowId: windowTwo.id, url: panelUrl });
    const panelTwo = await secondPanel;
    await panelTwo.waitForURL(panelUrl);

    const heading = (panel: Page, id: string) => panel.getByRole('heading', { name: `We decided to use ${id}.`, exact: true });
    const assertActive = async (windowId: number, tabId: number) => {
      expect(await panelOne.evaluate(async windowId => (await chrome.tabs.query({ active: true, windowId }))[0]?.id, windowId)).toBe(tabId);
    };
    const invokeSource = async (panel: Page) => panel.getByRole('button', { name: 'View source', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    const focusedWindow = () => panelOne.evaluate(async () => (await chrome.windows.getAll()).find(window => window.focused)?.id);
    const sourceOne = chatOne.locator('[data-chatgpt-selection-message-id="message-window-one"]');
    const sourceTwo = chatTwo.locator('[data-chatgpt-selection-message-id="message-window-two"]');
    await expect(heading(panelOne, 'window-one')).toBeVisible();
    await expect(heading(panelTwo, 'window-two')).toBeVisible();
    await expect(heading(panelOne, 'window-two')).toHaveCount(0);
    await expect(heading(panelTwo, 'window-one')).toHaveCount(0);
    expect(await panelTwo.evaluate(async () => (await chrome.windows.getCurrent()).id)).toBe(windowTwo.id);

    const focused = await focusedWindow();
    expect([windowOne, windowTwo.id]).toContain(focused);
    await assertActive(windowOne, tabOne);
    await assertActive(windowTwo.id, windowTwo.tabId);
    // Prove the unfocused window's panel routes to its own conversation while
    // another window is actually focused. This headless build does not expose
    // reliable OS focus transitions, so those remain a separate live check.
    const unfocused = focused === windowOne ? [panelTwo, sourceTwo, panelOne, sourceOne] as const : [panelOne, sourceOne, panelTwo, sourceTwo] as const;
    await invokeSource(unfocused[0]);
    await expect(unfocused[1]).toHaveCSS('outline-style', 'solid');
    await expect(unfocused[3]).not.toHaveCSS('outline-style', 'solid');
    expect(await focusedWindow()).toBe(focused);
    await unfocused[1].evaluate(element => { (element as HTMLElement).style.outline = ''; });
    await invokeSource(unfocused[2]);
    await expect(unfocused[3]).toHaveCSS('outline-style', 'solid');
    await expect(unfocused[1]).not.toHaveCSS('outline-style', 'solid');
    expect(await focusedWindow()).toBe(focused);

    // Inactive extension pages stand in for native side panels. Keeping their
    // chat tabs active is essential to testing each panel's window routing.
    for (const [windowId, tabId, changed, unchanged, unchangedId] of [
      [windowTwo.id, windowTwo.tabId, panelTwo, panelOne, 'window-one'],
      [windowOne, tabOne, panelOne, panelTwo, 'window-two'],
    ] as const) {
      await panelOne.evaluate(async windowId => { await chrome.tabs.create({ windowId, url: 'about:blank', active: true }); }, windowId);
      await expect(changed.getByRole('heading', { name: 'Open a ChatGPT conversation' })).toBeVisible();
      await expect(changed.getByRole('button', { name: 'View source' })).toHaveCount(0);
      await expect(heading(unchanged, unchangedId)).toBeVisible();
      await panelOne.evaluate(async tabId => { await chrome.tabs.update(tabId, { active: true }); }, tabId);
      await expect(heading(changed, unchangedId === 'window-one' ? 'window-two' : 'window-one')).toBeVisible();
      await sourceOne.evaluate(element => { (element as HTMLElement).style.outline = ''; });
      await sourceTwo.evaluate(element => { (element as HTMLElement).style.outline = ''; });
      await invokeSource(changed);
      await expect(unchangedId === 'window-one' ? sourceTwo : sourceOne).toHaveCSS('outline-style', 'solid');
      await expect(unchangedId === 'window-one' ? sourceOne : sourceTwo).not.toHaveCSS('outline-style', 'solid');
    }
    await assertActive(windowOne, tabOne);
    await assertActive(windowTwo.id, windowTwo.tabId);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
