import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Synthetic current-layout timeline. It starts with only the last four turns
// loaded, prepends history asynchronously, and unmounts off-screen messages.
const fixture = (holdHistory = false) => `<!doctype html><html><head><title>Virtualized fixture - ChatGPT</title></head><body>
<main><div data-app-action-timeline-scroll style="height:420px;overflow-y:auto;position:relative">
<div data-thread-find-target="conversation"><div id="loading" role="status">Loading older messages…</div><div id="range" style="position:relative"></div></div>
</div></main>
<script>
const scroller=document.querySelector('[data-app-action-timeline-scroll]'), range=document.getElementById('range');
let loaded=4, pending=false;
let holdHistory=${holdHistory}, pendingHistory;
window.addEventListener('fixture-release-history',()=>{holdHistory=false;pendingHistory?.();pendingHistory=undefined;});
function render(){
  range.style.height=(loaded*800)+'px';
  const first=Math.max(0,Math.floor(scroller.scrollTop/800)-1),last=Math.min(loaded,first+4);
  let html='';
  for(let position=first;position<last;position++){
    const id=9-loaded+position;
    html+='<div style="position:absolute;top:'+(position*800)+'px;height:790px;width:100%" data-turn-key="turn-'+id+'"><div data-content-search-turn-key="fallback-turn-'+position+'"><div data-talvt-turn-state="complete">'
      +'<div data-chatgpt-search-unit-key="fallback-turn-'+position+':0:user" data-chatgpt-search-message-ids="user-'+id+'"><div data-user-message-bubble="true">Which fixture '+id+' should we review?</div></div>'
      +'<div data-chatgpt-search-unit-key="fallback-turn-'+position+':2:assistant" data-chatgpt-search-message-ids="assistant-'+id+' assistant-'+id+'"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-chatgpt-selection-conversation-id="virtualized" data-chatgpt-selection-message-id="assistant-'+id+'"><div data-markdown-text-style="assistant-message"><p>We decided to ship fixture '+id+'.</p><p>TODO: verify fixture '+id+'.</p></div></div></div></div></div></div>';
  }
  if(range.innerHTML!==html)range.innerHTML=html;
}
scroller.addEventListener('scroll',()=>{
  if(scroller.scrollTop<=2&&loaded===4&&!pending){
    pending=true;
    const prepend=()=>{loaded=9;document.getElementById('loading').remove();delete document.body.dataset.historyWaiting;render();scroller.scrollTop+=4000;render();pending=false;};
    if(holdHistory){pendingHistory=prepend;document.body.dataset.historyWaiting='true';}else setTimeout(prepend,80);
  }
  render();
});
render();scroller.scrollTop=scroller.scrollHeight;render();
</script></body></html>`;

test('traverses lazy-prepended history, restores reading position, and recovers an unmounted exact source', async () => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(join(tmpdir(), 'sidekick-virtualized-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve('dist');
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture() }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/virtualized');
    const panel = await context.newPage();
    await panel.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/c/virtualized'))!;
      await chrome.tabs.update(tab.id!, { active: true });
    });
    await expect(panel.getByRole('heading', { name: 'We decided to ship fixture 8.' })).toBeVisible();
    await panel.getByRole('button', { name: 'Reindex conversation', exact: true }).evaluate(button => (button as HTMLElement).click());
    await expect(panel.getByText('Outline up to date')).toBeVisible({ timeout: 25_000 });
    await expect(panel.getByText('9 of 9 discovered turns captured')).toBeVisible();
    await expect.poll(() => chat.locator('[data-app-action-timeline-scroll]').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(5);
    await expect(chat.locator('[data-chatgpt-selection-message-id="assistant-0"]')).toHaveCount(0);
    await panel.getByRole('searchbox', { name: 'Search outline' }).fill('We decided to ship fixture 0.');
    await expect(panel.getByRole('button', { name: 'View source', exact: true })).toHaveCount(1);
    await panel.getByRole('button', { name: 'View source', exact: true }).evaluate(button => (button as HTMLElement).click());
    await expect(panel.getByText('Source located in the conversation.')).toBeVisible({ timeout: 25_000 });
    await expect(chat.locator('[data-chatgpt-selection-message-id="assistant-0"]')).toHaveCSS('outline-style', 'solid');
    await expect(chat.locator('[data-chatgpt-selection-message-id="assistant-0"]')).toContainText('We decided to ship fixture 0.');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('stopping a held scan retains sources, restores reading position, and rejects its delayed continuation', async () => {
  test.setTimeout(45_000);
  const profile = await mkdtemp(join(tmpdir(), 'sidekick-cancel-'));
  let context: BrowserContext | undefined;
  try {
    const extension = resolve('dist');
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture(true) }));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/virtualized');
    const panel = await context.newPage();
    await panel.addInitScript(() => Object.defineProperty(document, 'hidden', { get: () => false }));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    type CaptureEvent = { runId: string; phase: string; sequence: number; error?: string };
    await panel.evaluate(() => {
      const recorder = window as typeof window & { sidekickCaptureLog: CaptureEvent[] };
      recorder.sidekickCaptureLog = [];
      chrome.runtime.onMessage.addListener((value, sender) => {
        if (sender.tab?.url?.includes('/c/virtualized') && value?.kind === 'content/capture') {
          const { runId, phase, sequence, error } = value.batch;
          recorder.sidekickCaptureLog.push({ runId, phase, sequence, error });
        }
      });
    });
    await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url?.includes('/c/virtualized'))!;
      await chrome.tabs.update(tab.id!, { active: true });
    });
    const scroller = chat.locator('[data-app-action-timeline-scroll]');
    const originalTop = await scroller.evaluate(element => element.scrollTop);
    await expect(panel.getByRole('heading', { name: 'We decided to ship fixture 8.' })).toBeVisible();
    const invoke = async (name: string) => panel.getByRole('button', { name, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await invoke('Reindex conversation');
    await expect(chat.locator('body')).toHaveAttribute('data-history-waiting', 'true');
    await expect(panel.getByRole('button', { name: 'Stop indexing' })).toBeVisible();
    await panel.setViewportSize({ width: 360, height: 600 });
    await panel.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await panel.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(panel.getByRole('button', { name: 'Stop indexing' })).toBeInViewport();
    await panel.screenshot({ path: 'test-results/sidekick-indexing-controls.png' });
    expect(await scroller.evaluate(element => element.scrollTop)).toBeLessThan(originalTop);
    await invoke('Stop indexing');
    const stoppedMessage = 'Indexing stopped. Captured sources are retained.';
    await expect(panel.getByRole('alert').filter({ hasText: stoppedMessage })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop indexing' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Reindex conversation' })).toBeEnabled();
    await expect(panel.getByRole('heading', { name: 'We decided to ship fixture 8.' })).toBeVisible();
    expect(await scroller.evaluate(element => element.scrollTop)).toBeCloseTo(originalTop, 0);
    const checkpoint = await panel.evaluate(() => {
      const events = (window as typeof window & { sidekickCaptureLog: CaptureEvent[] }).sidekickCaptureLog;
      const stopped = events.filter(event => event.phase === 'partial' && event.error === 'Indexing stopped. Captured sources are retained.').at(-1);
      if (!stopped) throw new Error('Cancellation batch was not observed');
      return { runId: stopped.runId, length: events.length };
    });
    await chat.evaluate(() => window.dispatchEvent(new Event('fixture-release-history')));
    // Release the exact awaited operation, then allow two traversal settles
    // (120ms each), the passive debounce (250ms), and one small scheduling margin.
    await chat.waitForTimeout(2 * 120 + 250 + 50);
    await expect(panel.getByText('History coverage is partial')).toBeVisible();
    await expect(panel.getByRole('alert').filter({ hasText: stoppedMessage })).toBeVisible();
    expect(await scroller.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(2);
    expect(await panel.evaluate(({ length, runId }) => (window as typeof window & { sidekickCaptureLog: CaptureEvent[] }).sidekickCaptureLog.slice(length)
      .filter(event => event.runId === runId && (event.phase === 'ready' || event.phase === 'capturing')), checkpoint)).toEqual([]);
    await invoke('Reindex conversation');
    await expect(panel.getByText('Outline up to date')).toBeVisible({ timeout: 25_000 });
    await expect(panel.getByText('9 of 9 discovered turns captured')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'We decided to ship fixture 0.' })).toBeVisible();
    expect(await scroller.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(2);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
