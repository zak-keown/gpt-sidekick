import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { categories, type Category, type CommandResult, type PanelRequest, type PanelState } from '../core/types';
import { demoState } from './demo';

export interface PanelTransport {
  getWindowId(): Promise<number>;
  request(request: PanelRequest): Promise<PanelState | CommandResult>;
  copy(text: string): Promise<void>;
  subscribe?(windowId: number, onChange: () => void): () => void;
}
const browserTransport: PanelTransport = {
  async getWindowId() { const win = await chrome.windows.getCurrent(); if (win.id === undefined) throw new Error('This panel has no browser window.'); return win.id; },
  request: request => chrome.runtime.sendMessage(request),
  copy: text => navigator.clipboard.writeText(text),
  subscribe(windowId, onChange) {
    const activated = (info: chrome.tabs.OnActivatedInfo) => { if (info.windowId === windowId) onChange(); };
    const updated = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => { if (tab.windowId === windowId && tab.active && (change.url || change.status === 'loading')) onChange(); };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    return () => { chrome.tabs.onActivated.removeListener(activated); chrome.tabs.onUpdated.removeListener(updated); };
  },
};
const labels: Record<Category, string> = { decision: 'Decisions', action: 'Actions', question: 'Questions', artifact: 'Artifacts', code: 'Code', correction: 'Corrections', note: 'Notes' };
const phases = { idle: 'Waiting for capture', capturing: 'Reading the conversation', ready: 'Outline up to date', partial: 'History coverage is partial', failed: 'Capture stopped' };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not connect to Sidekick.';
const displayCode = (quote: string) => quote.replace(/^\s*```[^\n]*\n/, '').replace(/\n```\s*$/, '');

export function App({ transport = browserTransport, demo = false, pollMs = 1200 }: { transport?: PanelTransport; demo?: boolean; pollMs?: number }) {
  const [state, setState] = useState<PanelState | null>(demo ? demoState : null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [confirm, setConfirm] = useState<'panel/delete' | 'panel/delete-all' | null>(null);
  const [busy, setBusy] = useState(false);
  const windowId = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const queuedRead = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (demo || windowId.current === undefined) return;
    if (inFlight.current) { queuedRead.current = true; return; }
    inFlight.current = true;
    const version = generation.current;
    try {
      const next = await transport.request({ kind: 'panel/state', windowId: windowId.current });
      if (!('supported' in next)) throw new Error('Sidekick returned an invalid state.');
      if (mounted.current && generation.current === version) {
        setState(previous => { if (previous && (previous.tabId !== next.tabId || previous.snapshot?.conversationId !== next.snapshot?.conversationId)) { setConfirm(null); setNotice(''); setActionError(''); } return next; });
        setError('');
      }
    } catch (failure) {
      if (mounted.current && generation.current === version) { setState(null); setConfirm(null); setError(errorText(failure)); }
    } finally { inFlight.current = false; if (queuedRead.current && mounted.current) { queuedRead.current = false; void refresh(); } }
  }, [transport, demo]);

  useEffect(() => {
    mounted.current = true;
    if (demo) return () => { mounted.current = false; };
    const version = ++generation.current;
    let unsubscribe: (() => void) | undefined;
    void transport.getWindowId().then(id => { if (mounted.current && generation.current === version) {
      windowId.current = id;
      unsubscribe = transport.subscribe?.(id, () => { ++generation.current; setState(null); setConfirm(null); setNotice(''); setError(''); setActionError(''); void refresh(); });
      void refresh();
    } }).catch(failure => { if (mounted.current && generation.current === version) { setState(null); setError(errorText(failure)); } });
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, pollMs);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { mounted.current = false; ++generation.current; windowId.current = undefined; queuedRead.current = false; unsubscribe?.(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [transport, demo, pollMs, refresh]);

  const action = async (kind: 'panel/reindex' | 'panel/jump' | 'panel/delete' | 'panel/delete-all', itemId?: string) => {
    if (busy) return;
    if (demo) { setNotice('Preview only. Open Sidekick on ChatGPT to use this action.'); setConfirm(null); return; }
    if (windowId.current === undefined) return;
    const version = ++generation.current;
    setBusy(true); setNotice(kind === 'panel/jump' ? 'Locating source…' : ''); setError(''); setActionError('');
    try {
      const result = await transport.request(kind === 'panel/jump' ? { kind, windowId: windowId.current, itemId: itemId! } : { kind, windowId: windowId.current });
      if (!('ok' in result) || !result.ok) throw new Error('error' in result ? result.error : 'Sidekick returned an invalid response.');
      if (mounted.current && version === generation.current) { setNotice(kind === 'panel/jump' ? 'Source located in the conversation.' : kind === 'panel/reindex' ? 'Indexing requested.' : 'Saved data deleted.'); if (kind === 'panel/delete' || kind === 'panel/delete-all') setState(null); }
    } catch (failure) { if (mounted.current && version === generation.current) { setNotice(''); setActionError(errorText(failure)); } }
    finally { if (mounted.current) { setBusy(false); setConfirm(null); } void refresh(); }
  };
  const copy = async (text: string) => { try { await transport.copy(text); setNotice('Copied to clipboard.'); } catch { setNotice('Could not copy. Check clipboard permission and try again.'); } };
  const snapshot = state?.snapshot;
  const search = query.trim().toLocaleLowerCase();
  const items = snapshot?.items.filter(item => (category === 'all' || category === item.category) && `${item.title} ${item.evidence.quote}`.toLocaleLowerCase().includes(search)) ?? [];
  return <main>
    <header class="masthead"><span class="wordmark">Sidekick<span class="brand-spine" aria-hidden="true">↳</span></span><span class="local">On this device</span></header>
    {demo && <p class="demo">Preview with sample conversation data</p>}
    <section class="conversation" aria-label="Current conversation">
      <h1>{snapshot?.title || 'Your conversation, outlined'}</h1>
      {snapshot && <><p class={`phase phase-${snapshot.phase}`}>{phases[snapshot.phase]}</p><p class="capture-detail">{snapshot.progress.capturedTurns} of {snapshot.progress.totalTurns} {snapshot.progress.coverage === 'traversed' ? 'discovered' : 'loaded'} turns captured{snapshot.progress.unstableMessages > 0 ? ` · ${snapshot.progress.unstableMessages} still changing` : ''}</p>{snapshot.phase === 'capturing' && snapshot.progress.totalTurns > 0 && <progress aria-label="Conversation capture" value={snapshot.progress.coverage === 'traversed' ? undefined : snapshot.progress.capturedTurns} max={snapshot.progress.totalTurns} />}{snapshot.phase === 'partial' && <p class="hint">{snapshot.progress.coverage === 'traversed' ? 'Captured sources are retained. Wait for changing messages to finish, or reindex to check history again.' : 'Earlier or virtualized messages may be missing. Load more of the conversation, then reindex.'}</p>}{snapshot.error && <p role="alert" class="error">{snapshot.error}</p>}</>}
    </section>
    {(error || state?.error) && <div class="error" role="alert"><p>{error || state?.error}</p><button onClick={() => void refresh()}>Try again</button></div>}
    {actionError && <div class="error" role="alert"><p>{actionError}</p><button onClick={() => setActionError('')}>Dismiss</button></div>}
    <p class="notice" role="status" aria-live="polite">{notice}</p>
    {!state && !error && <p class="empty">Connecting to this window’s conversation…</p>}
    {state && !state.supported && <div class="empty"><h2>Open a ChatGPT conversation</h2><p>Sidekick follows the active tab in this window. Open a saved conversation on chatgpt.com to build its outline.</p></div>}
    {state?.supported && !snapshot && <div class="empty"><h2>Ready to read</h2><p>Open a conversation and let its messages load. Reindex to capture what is available.</p></div>}
    {snapshot && <><div class="tools"><label class="search-label"><span class="sr-only">Search outline</span><input type="search" placeholder="Find in outline" value={query} onInput={event => setQuery(event.currentTarget.value)} /></label><label><span class="sr-only">Filter category</span><select value={category} onChange={event => setCategory(event.currentTarget.value as Category | 'all')}><option value="all">All categories</option>{categories.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label></div>
      <div class="outline-meta"><span>{items.length} {items.length === 1 ? 'item' : 'items'}</span><button disabled={!items.length} onClick={() => void copy(items.map(item => `${labels[item.category]}: ${item.title}\n“${item.evidence.quote}”`).join('\n\n'))}>Copy outline</button></div>
      {!items.length && <p class="empty">{snapshot.items.length ? 'No items match. Try another search or category.' : snapshot.phase === 'capturing' ? 'Reading messages. Outline items will appear as sources are captured.' : 'No outline items found in the captured messages. Reindex after more messages load.'}</p>}
      {categories.map(group => { const grouped = items.filter(item => item.category === group); return grouped.length ? <section class="outline-group" key={group} aria-labelledby={`group-${group}`}><h2 id={`group-${group}`}>{labels[group]} <span>{grouped.length}</span></h2><ol>{grouped.map(item => <li class="outline-item" key={item.id}><h3>{item.title}</h3>{item.category === 'code' ? <pre class="code-evidence"><code>{displayCode(item.evidence.quote)}</code></pre> : <blockquote>{item.evidence.quote}</blockquote>}<div class="item-actions"><button disabled={busy} onClick={() => void action('panel/jump', item.id)}>View source</button><button onClick={() => void copy(`${item.title}\n“${item.evidence.quote}”`)} aria-label={`Copy ${item.title}`}>Copy</button></div></li>)}</ol></section> : null; })}
    </>}
    <footer><div class="footer-actions"><button disabled={busy || !state?.supported} onClick={() => void action('panel/reindex')}>Reindex conversation</button><button disabled={busy || !snapshot} onClick={() => setConfirm('panel/delete')}>Delete this outline</button><button disabled={busy} onClick={() => setConfirm('panel/delete-all')}>Delete all saved data</button></div>{confirm && <div class="confirmation" role="alert"><p>{confirm === 'panel/delete' ? 'Delete this conversation’s saved messages and outline?' : 'Delete all saved conversations and outlines from this device?'}</p><div><button disabled={busy} class="danger" onClick={() => void action(confirm)}>Delete {confirm === 'panel/delete' ? 'this conversation' : 'all saved data'}</button><button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button></div></div>}<p class="privacy">Extracted from captured messages. Quotes link back to their source.</p></footer>
  </main>;
}
