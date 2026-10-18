import { conversationIdFromUrl, type CaptureBatch, type CommandResult, type ContentCommand, type Role, type TranscriptMessage } from '../core/types';
import { walkTimeline } from './timeline';

const turnSelector = '[data-turn-id],[data-turn-key]';
const messageSelector = '[data-message-author-role],[data-user-message-bubble],[data-chatgpt-selection-message-id]';
const turnIdOf = (turn: Element): string | null => turn.getAttribute('data-turn-id') ?? turn.getAttribute('data-turn-key');
const modernCoverage = 'Captured mounted messages. This timeline loads and virtualizes earlier history; complete conversation coverage is not verified.';

/** Current-layout search units may repeat one ID, but distinct IDs are ambiguous. */
function messageIdentity(element: Element, conversationId: string | null): { id: string; role: Role } | null {
  if (!conversationId) return null;
  if (element.hasAttribute('data-message-author-role')) {
    const id = element.getAttribute('data-message-id');
    const role = element.getAttribute('data-message-author-role');
    return id && role && ['user', 'assistant', 'system', 'tool'].includes(role) ? { id, role: role as Role } : null;
  }
  const unit = element.closest('[data-chatgpt-search-message-ids]');
  const ids = [...new Set((unit?.getAttribute('data-chatgpt-search-message-ids') ?? '').trim().split(/\s+/).filter(Boolean))];
  if (ids.length !== 1 || !ids[0]) return null;
  const key = unit?.getAttribute('data-chatgpt-search-unit-key') ?? '';
  if (element.hasAttribute('data-user-message-bubble') && key.endsWith(':user')) return { id: ids[0], role: 'user' };
  if (element.hasAttribute('data-chatgpt-selection-message-id') && key.endsWith(':assistant')
    && element.getAttribute('data-chatgpt-selection-conversation-id') === conversationId
    && element.getAttribute('data-chatgpt-selection-message-id') === ids[0]) return { id: ids[0], role: 'assistant' };
  return null;
}
const excluded = 'button,script,style,noscript,svg,[hidden],[aria-hidden="true"],[role="toolbar"],.sr-only,[data-sidekick-highlight]';
const blocks = new Set(['P', 'DIV', 'PRE', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'TR']);

/** The same deterministic canonical text is used for capture and evidence checks. */
export function canonicalMessageText(message: Element): string {
  if (message.closest('[hidden],[aria-hidden="true"]')) return '';
  const content = message.querySelector('[data-message-content],[data-markdown-text-style="assistant-message"],.markdown,.whitespace-pre-wrap') ?? message;
  function visit(node: Node, code = false, preserve = false): string {
    if (node.nodeType === 3) return code || preserve ? node.textContent ?? '' : (node.textContent ?? '').replace(/[\t\r\n ]+/g, ' ');
    if (node.nodeType !== 1) return '';
    const element = node as HTMLElement;
    if (element.matches(excluded)) return '';
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style?.display === 'none' || style?.visibility === 'hidden') return '';
    if (element.tagName === 'BR') return '\n';
    // Code widgets often put a language label and copy button beside the PRE.
    if (element.tagName !== 'PRE' && !element.querySelector('pre') && element.querySelector('button') && element.parentElement?.querySelector(':scope > pre')) return '';
    const isCode = code || element.tagName === 'PRE';
    const preserveText = preserve || isCode || element.classList.contains('whitespace-pre-wrap') || style?.whiteSpace.startsWith('pre') === true;
    const text = Array.from(element.childNodes, child => visit(child, isCode, preserveText)).join('');
    if (element.tagName === 'PRE' && !code) return `\n\`\`\`\n${text}\n\`\`\`\n`;
    return !code && blocks.has(element.tagName) ? `\n${text}\n` : text;
  }
  // Trim only the content boundary; preserve indentation and blank lines within code.
  return visit(content).replace(/^\s+|\s+$/g, '');
}

export interface ProviderOptions {
  document: Document;
  window: Window;
  send: (batch: CaptureBatch) => Promise<unknown> | unknown;
  debounceMs?: number;
  settleMs?: number;
  maxTurns?: number;
  maxScanMs?: number;
  maxJumpMs?: number;
  boundaryWaitMs?: number;
}

export interface ChatGPTProvider {
  start(): void;
  stop(): void;
  command(command: ContentCommand): Promise<CommandResult>;
  capture(): void;
}

/** Passive capture never scrolls. Full indexing is only entered by an explicit command. */
export function createChatGPTProvider(options: ProviderOptions): ChatGPTProvider {
  const { document: doc, window: win } = options;
  const settleMs = options.settleMs ?? 90;
  let current = conversationIdFromUrl(win.location.href);
  let generation = 0;
  let runId = newRunId();
  let sequence = 0;
  let paused = false;
  let scanning = false;
  let started = false;
  let observer: MutationObserver | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let messages = new Map<string, TranscriptMessage>();
  let indexedTurnIds: string[] | undefined;
  let indexedModernTurns: string[] | undefined;
  let delivery = Promise.resolve();
  let highlighted: { element: HTMLElement; original: string; timer: ReturnType<typeof setTimeout> } | undefined;
  type RouteNode = { element: Element; attribute: string; value: string | null };
  let routeQuarantine: RouteNode[] = [];
  let knownRouteNodes = snapshotRouteNodes();
  let restoreScanScroll: (() => void) | undefined;

  function clearHighlight(): void {
    if (!highlighted) return;
    clearTimeout(highlighted.timer);
    highlighted.element.style.outline = highlighted.original;
    highlighted = undefined;
  }

  function newRunId(): string {
    return globalThis.crypto.randomUUID();
  }

  function cancel(): void {
    clearHighlight();
    restoreScanScroll?.();
    restoreScanScroll = undefined;
    generation++;
    scanning = false;
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
  }

  function newRun(): void {
    cancel();
    runId = newRunId();
    sequence = 0;
    messages = new Map();
    indexedTurnIds = undefined;
    indexedModernTurns = undefined;
  }

  function navigate(): void {
    const next = conversationIdFromUrl(win.location.href);
    if (next === current) {
      routeDomReady();
      return;
    }
    // SPA history changes can precede React replacing the prior conversation.
    // A new URL alone is never evidence that the old DOM belongs to that URL.
    routeQuarantine = knownRouteNodes;
    current = next;
    newRun();
    schedule();
  }

  function routeDomReady(): boolean {
    routeQuarantine = routeQuarantine.filter(entry => entry.element.isConnected && entry.element.getAttribute(entry.attribute) === entry.value);
    if (!routeQuarantine.length) knownRouteNodes = snapshotRouteNodes();
    return routeQuarantine.length === 0;
  }

  function snapshotRouteNodes(): RouteNode[] {
    return [
      ...wrappers().map(element => {
        const attribute = element.hasAttribute('data-turn-id') ? 'data-turn-id' : 'data-turn-key';
        return { element, attribute, value: element.getAttribute(attribute) };
      }),
      ...Array.from(doc.querySelectorAll(messageSelector), element => {
        const host = element.hasAttribute('data-user-message-bubble') ? element.closest('[data-chatgpt-search-message-ids]') ?? element : element;
        const attribute = host.hasAttribute('data-message-id') ? 'data-message-id' : host.hasAttribute('data-chatgpt-selection-message-id') ? 'data-chatgpt-selection-message-id' : 'data-chatgpt-search-message-ids';
        return { element: host, attribute, value: host.getAttribute(attribute) };
      }),
    ];
  }

  function wrappers(): Element[] {
    return Array.from(doc.querySelectorAll(turnSelector)).filter(element => !element.parentElement?.closest(turnSelector));
  }

  function isStreaming(): boolean {
    return !!doc.querySelector('[data-is-streaming="true"],[aria-busy="true"],.result-streaming,[data-testid="stop-button"],[aria-label="Stop generating"],[data-talvt-turn-state="streaming"]');
  }

  function turnIds(turns: Element[]): string[] {
    return turns.map(turn => turnIdOf(turn) ?? '');
  }

  function sameTurns(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  function readTurn(turn: Element, ordinal: number): { rows: TranscriptMessage[]; unstable: number } {
    const candidates = Array.from(turn.querySelectorAll(messageSelector));
    if (turn.matches(messageSelector)) candidates.unshift(turn);
    const rows: TranscriptMessage[] = [];
    let unstable = 0;
    const turnId = turnIdOf(turn) ?? undefined;
    // This position key is used only for ordering, never as message identity.
    const position = /^fallback-turn-(\d+)$/.exec(turn.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key') ?? '');
    const order = position ? Number(position[1]) : ordinal;
    const seen = new Set<string>();
    for (const [index, element] of candidates.entries()) {
      const identity = messageIdentity(element, current);
      const text = canonicalMessageText(element);
      if (!identity || !text || !current) {
        unstable++;
        continue;
      }
      if (seen.has(identity.id)) continue;
      seen.add(identity.id);
      const scroller = doc.querySelector<HTMLElement>('[data-app-action-timeline-scroll]');
      const top = scroller ? Math.max(0, scroller.scrollTop + turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : 0;
      const scrollAnchor = scroller && scroller.scrollHeight > 0 ? { top, height: scroller.scrollHeight } : undefined;
      rows.push({ ...identity, conversationId: current, text, ordinal: order * 100 + index, ...(turnId ? { turnId } : {}), ...(scrollAnchor ? { scrollAnchor } : {}) });
    }
    return { rows, unstable };
  }

  function emit(mode: CaptureBatch['mode'], phase: CaptureBatch['phase'], capturedTurns: number, totalTurns: number, unstableMessages: number, error?: string, coverage?: 'mounted' | 'traversed'): void {
    if (!current || paused) return;
    const token = generation;
    const batch: CaptureBatch = {
      conversationId: current,
      title: doc.title.replace(/\s*[-–|]\s*ChatGPT\s*$/, '').trim() || 'Conversation',
      messages: Array.from(messages.values()).sort((a, b) => a.ordinal - b.ordinal),
      mode, phase, progress: { capturedTurns, totalTurns, unstableMessages, ...(coverage ? { coverage } : {}) }, runId, sequence: ++sequence,
      ...(error ? { error } : {}),
    };
    delivery = delivery.then(async () => {
      if (token === generation && !paused) await options.send(batch);
    }).catch(() => { /* A disconnected worker must not stop later captures. */ });
  }

  function capture(): void {
    navigate();
    if (!current || paused || scanning) return;
    if (!routeDomReady()) {
      emit('passive', 'partial', 0, 0, 0, 'Waiting for the previous conversation DOM to be replaced.');
      return;
    }
    const turns = wrappers();
    const coverageEstablished = !!indexedTurnIds && sameTurns(indexedTurnIds, turnIds(turns));
    const previouslyCapturedTurns = new Set(Array.from(messages.values(), message => message.turnId));
    let captured = 0;
    let unstable = 0;
    for (const [ordinal, turn] of turns.entries()) {
      const result = readTurn(turn, ordinal);
      unstable += result.unstable;
      if (result.rows.length && !result.unstable) captured++;
      else if (!result.unstable && coverageEstablished && previouslyCapturedTurns.has(turnIdOf(turn) ?? undefined)) captured++;
      if (result.rows.length && !result.unstable) {
        // Regenerating a turn can replace its stable message ID. Retain only
        // the current branch once that turn is mounted and readable again.
        const ids = new Set(result.rows.map(row => row.id));
        for (const [id, message] of messages) {
          if (message.turnId === turnIdOf(turn) && !ids.has(id)) messages.delete(id);
        }
      }
      for (const row of result.rows) messages.set(row.id, row);
    }
    // Full indexing establishes coverage. A subsequent stable streaming update
    // can finish that run without demoting an already complete transcript.
    const modern = turns.some(turn => turn.hasAttribute('data-turn-key'));
    const modernCertificate = indexedModernTurns;
    if (modern && modernCertificate && turns.some((turn, index) => {
      const position = modernPosition(turn);
      return position === undefined || modernCertificate[position] !== turnIdOf(turn) || !readTurn(turn, index).rows.length;
    })) indexedModernTurns = undefined;
    const modernComplete = modern && !!indexedModernTurns && !unstable && !isStreaming() && !historyPending();
    const complete = modernComplete || (!modern && coverageEstablished && captured === turns.length && !unstable && !isStreaming());
    const count = modernComplete ? indexedModernTurns!.length : captured;
    emit('passive', complete ? 'ready' : 'partial', count, modernComplete ? count : turns.length, unstable,
      complete ? undefined : isStreaming() ? 'The conversation is still streaming.' :
        modern ? modernCoverage : turns.length ? 'Visible messages captured. Run full indexing to check all available turns.' : 'No recognized conversation turns are available.', modernComplete ? 'traversed' : undefined);
  }

  function schedule(): void {
    if (paused || scanning || !started) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(capture, options.debounceMs ?? 250);
  }

  function valid(token: number, conversation: string): boolean {
    navigate();
    return token === generation && current === conversation && !paused;
  }

  const wait = () => new Promise<void>(resolve => setTimeout(resolve, settleMs));

  function modernPosition(turn: Element): number | undefined {
    const key = turn.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key') ?? '';
    const match = /^fallback-turn-(\d+)$/.exec(key);
    const value = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  function historyPending(): boolean {
    const conversation = doc.querySelector('[data-thread-find-target="conversation"]');
    return !!conversation && Array.from(conversation.querySelectorAll('[role="status"],[role="alert"]')).some(element =>
      !element.closest(turnSelector) && !element.closest('[hidden],[aria-hidden="true"]') && !!element.textContent?.trim());
  }

  /** Reading-position hints are recomputed against the current scroll range. */
  function readingPosition(): () => void {
    const scroller = doc.querySelector<HTMLElement>('[data-app-action-timeline-scroll]');
    if (!scroller) return () => undefined;
    const oldTop = scroller.scrollTop;
    const oldHeight = scroller.scrollHeight;
    const atBottom = oldTop + scroller.clientHeight >= oldHeight - 4;
    const viewportTop = scroller.getBoundingClientRect().top;
    const visible = wrappers().find(turn => turn.getBoundingClientRect().bottom > viewportTop + 1);
    const key = visible ? turnIdOf(visible) : null;
    const offset = visible ? visible.getBoundingClientRect().top - viewportTop : 0;
    const conversation = current;
    return () => {
      if (current !== conversation || conversationIdFromUrl(win.location.href) !== conversation || !scroller.isConnected) return;
      const target = key ? wrappers().find(turn => turnIdOf(turn) === key) : undefined;
      const captured = key ? [...messages.values()].find(message => message.turnId === key && message.scrollAnchor) : undefined;
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
      else if (target) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
      else if (captured?.scrollAnchor) scroller.scrollTop = Math.max(0, captured.scrollAnchor.top + scroller.scrollHeight - captured.scrollAnchor.height - offset);
      else scroller.scrollTop = Math.max(0, oldTop + scroller.scrollHeight - oldHeight);
    };
  }

  async function indexModern(token: number, conversation: string, scroller: HTMLElement): Promise<void> {
    const observed = new Map<string, { position?: number; stable: boolean; unstable: number }>();
    let lastProgress = 0;
    const observe = () => {
      const turns = wrappers();
      for (const [index, turn] of turns.entries()) {
        const id = turnIdOf(turn);
        if (!id) continue;
        const result = readTurn(turn, index);
        const state = turn.querySelector('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state');
        // A cancelled response is terminal and may leave only the user's message.
        const stable = result.rows.length > 0 && result.unstable === 0 && (state === 'complete' || state === 'cancelled');
        observed.set(id, { position: modernPosition(turn), stable, unstable: result.unstable });
        if (stable) {
          const ids = new Set(result.rows.map(row => row.id));
          for (const [messageId, message] of messages) if (message.turnId === id && !ids.has(messageId)) messages.delete(messageId);
        }
        for (const row of result.rows) messages.set(row.id, row);
      }
      if (Date.now() - lastProgress > 250) {
        const values = [...observed.values()];
        emit('full', 'capturing', values.filter(turn => turn.stable).length, observed.size, values.reduce((sum, turn) => sum + turn.unstable, 0), undefined, 'traversed');
        lastProgress = Date.now();
      }
      return { keys: turnIds(turns), pending: historyPending() };
    };
    emit('full', 'capturing', 0, 0, 0, undefined, 'traversed');
    const result = await walkTimeline({ scroller, observe, valid: () => valid(token, conversation), maxMs: options.maxScanMs ?? 45000,
      maxSteps: options.maxTurns ?? 2000, settleMs: Math.max(settleMs, 120), boundaryWaitMs: options.boundaryWaitMs ?? 1200 });
    if (!valid(token, conversation)) return;
    const ordered = [...observed].sort((a, b) => (a[1].position ?? Infinity) - (b[1].position ?? Infinity));
    const contiguous = ordered.length > 0 && ordered.every(([, turn], index) => turn.position === index && turn.stable);
    const unstable = ordered.reduce((sum, [, turn]) => sum + turn.unstable, 0);
    const complete = result.reason === 'end' && result.topConfirmed && result.bottomConfirmed && contiguous && !isStreaming() && !historyPending();
    if (complete) indexedModernTurns = ordered.map(([id]) => id);
    emit('full', complete ? 'ready' : 'partial', ordered.filter(([, turn]) => turn.stable).length, ordered.length, unstable,
      complete ? undefined : result.reason === 'limit' ? 'Indexing reached its time or step limit. Captured history is retained; reindex to try again.' :
        'Some history boundaries or message positions could not be verified. Captured history is retained.', 'traversed');
  }

  async function fullIndex(): Promise<void> {
    newRun();
    if (!current) return;
    if (!routeDomReady()) {
      emit('full', 'partial', 0, 0, 0, 'Waiting for the previous conversation DOM to be replaced. Run indexing again after it loads.');
      return;
    }
    scanning = true;
    const conversation = current;
    const token = generation;
    const turns = wrappers();
    const modernScroller = turns.some(turn => turn.hasAttribute('data-turn-key')) ? doc.querySelector<HTMLElement>('[data-app-action-timeline-scroll]') : null;
    if (modernScroller) {
      const restore = readingPosition();
      restoreScanScroll = restore;
      try { await indexModern(token, conversation, modernScroller); }
      catch (error) { if (valid(token, conversation)) emit('full', 'failed', 0, 0, 0, error instanceof Error ? error.message : 'History traversal failed.', 'traversed'); }
      finally {
        if (restoreScanScroll === restore) { restore(); restoreScanScroll = undefined; }
        if (valid(token, conversation)) scanning = false;
      }
      return;
    }
    const scrollPositions = Array.from(doc.querySelectorAll<HTMLElement>('*'))
      .filter(element => element.scrollTop !== 0 || element.scrollLeft !== 0 || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    const scrollX = win.scrollX;
    const scrollY = win.scrollY;
    const restore = () => {
      if (current !== conversation || conversationIdFromUrl(win.location.href) !== conversation) return;
      for (const position of scrollPositions) {
        if (position.element.isConnected) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
      }
      win.scrollTo?.(scrollX, scrollY);
    };
    restoreScanScroll = restore;
    const start = Date.now();
    let captured = 0;
    let unstable = 0;
    let error: string | undefined;
    emit('full', 'capturing', 0, turns.length, 0);
    try {
      for (const [ordinal, turn] of turns.entries()) {
        if (!valid(token, conversation)) return;
        if (ordinal >= (options.maxTurns ?? 2000) || Date.now() - start > (options.maxScanMs ?? 45000)) {
          error = 'Indexing reached its safety limit before every turn could be checked.';
          break;
        }
        turn.scrollIntoView?.({ block: 'center', behavior: 'instant' });
        let result = readTurn(turn, ordinal);
        // A virtualized wrapper may need a paint after being scrolled into view.
        for (let attempt = 0; attempt < 3 && (!result.rows.length || result.unstable); attempt++) {
          await wait();
          if (!valid(token, conversation)) return;
          const turnId = turnIdOf(turn);
          const live = wrappers().find(candidate => turnIdOf(candidate) === turnId) ?? turn;
          result = readTurn(live, ordinal);
        }
        unstable += result.unstable;
        if (result.rows.length && !result.unstable) captured++;
        for (const row of result.rows) messages.set(row.id, row);
        emit('full', 'capturing', captured, turns.length, unstable);
      }
      if (!valid(token, conversation)) return;
      if (!sameTurns(turnIds(wrappers()), turnIds(turns))) error = 'Conversation changed while indexing; run indexing again.';
      // Recheck mounted messages: an early streaming turn may have completed
      // while later virtualized wrappers were being hydrated.
      for (const [ordinal, turn] of wrappers().entries()) {
        const result = readTurn(turn, ordinal);
        if (result.unstable) {
          unstable = Math.max(unstable, result.unstable);
          error = 'A message changed or became unavailable while indexing. Run indexing again.';
        }
        if (result.rows.length && !result.unstable) {
          for (const row of result.rows) {
            const prior = Array.from(messages.values()).filter(message => message.turnId === row.turnId);
            if (prior.length && !prior.some(message => message.id === row.id)) error = 'The conversation branch changed while indexing. Run indexing again.';
            messages.set(row.id, row);
          }
        }
      }
      const covered = turns.length > 0 && captured === turns.length && unstable === 0 && !error;
      const modern = turns.some(turn => turn.hasAttribute('data-turn-key'));
      if (covered && !modern) indexedTurnIds = turnIds(turns);
      const streaming = isStreaming();
      const complete = covered && !streaming && !modern;
      emit('full', complete ? 'ready' : 'partial', captured, turns.length, unstable,
        error ?? (complete ? undefined : streaming ? 'The conversation is still streaming.' : modern ? modernCoverage : 'Some turns are unavailable, empty, or lack stable message IDs.'));
    } catch (cause) {
      if (valid(token, conversation)) emit('full', 'failed', captured, turns.length, unstable, cause instanceof Error ? cause.message : 'Indexing failed.');
    } finally {
      if (restoreScanScroll === restore) {
        restore();
        restoreScanScroll = undefined;
      }
      if (valid(token, conversation)) scanning = false;
    }
  }

  async function jump(command: Extract<ContentCommand, { kind: 'content/jump' }>): Promise<CommandResult> {
    navigate();
    if (paused) return { ok: false, error: 'Capture is paused after deletion. Index the conversation to resume.' };
    if (!routeDomReady()) return { ok: false, error: 'The previous conversation is still being replaced.' };
    if (scanning) return { ok: false, error: 'Wait for indexing to finish before opening a source.' };
    const { message, evidence } = command;
    if (current !== command.conversationId || message.conversationId !== current || evidence.messageId !== message.id ||
      !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start ||
      evidence.end > message.text.length || !evidence.quote.length ||
      message.text.slice(evidence.start, evidence.end) !== evidence.quote) return { ok: false, error: 'The source evidence does not match this conversation.' };
    const token = generation;
    const conversation = current;
    if (!conversation) return { ok: false, error: 'Open a saved ChatGPT conversation first.' };
    const findMessage = () => Array.from(doc.querySelectorAll(messageSelector)).find(element => messageIdentity(element, current)?.id === message.id);
    let element = findMessage();
    if (!element && message.turnId) {
      const turn = wrappers().find(candidate => turnIdOf(candidate) === message.turnId);
      if (turn) {
        turn.scrollIntoView?.({ block: 'center', behavior: 'instant' });
        for (let attempt = 0; attempt < 3 && !element; attempt++) {
          await wait();
          if (!valid(token, conversation)) return { ok: false, error: 'Conversation changed while locating the source.' };
          element = findMessage();
        }
      }
    }
    let restoreFailedLookup: (() => void) | undefined;
    const scroller = doc.querySelector<HTMLElement>('[data-app-action-timeline-scroll]');
    if (!element && scroller && wrappers().some(turn => turn.hasAttribute('data-turn-key'))) {
      const restore = readingPosition();
      restoreFailedLookup = restore;
      restoreScanScroll = restore;
      scanning = true;
      try {
        if (message.scrollAnchor) {
          // Layout changes or a prepend can shift this hint. It never establishes identity.
          const ratio = scroller.scrollHeight / message.scrollAnchor.height;
          scroller.scrollTop = Math.max(0, message.scrollAnchor.top * ratio);
          await wait();
          if (!valid(token, conversation)) return { ok: false, error: 'Conversation changed while locating the source.' };
          element = findMessage();
        }
        if (!element) {
          await walkTimeline({ scroller, observe: () => ({ keys: turnIds(wrappers()), found: !!findMessage(), pending: historyPending() }),
            valid: () => valid(token, conversation), maxMs: options.maxJumpMs ?? 20000, settleMs: Math.max(settleMs, 120),
            boundaryWaitMs: options.boundaryWaitMs ?? 1200, maxSteps: options.maxTurns ?? 2000 });
          if (valid(token, conversation)) element = findMessage();
        }
      } catch {
        restore();
        return { ok: false, error: 'Source lookup failed. The previous reading position was restored.' };
      } finally {
        if (restoreScanScroll === restore) restoreScanScroll = undefined;
        if (valid(token, conversation)) { scanning = false; schedule(); }
      }
    }
    // A remounted message boundary can precede hydration of its widgets. Wait
    // briefly for the exact saved text; never accept a merely similar revision.
    if (element?.hasAttribute('data-chatgpt-selection-message-id') && canonicalMessageText(element) !== message.text) {
      for (let attempt = 0; attempt < 12; attempt++) {
        await wait();
        if (!valid(token, conversation)) { restoreFailedLookup?.(); return { ok: false, error: 'Conversation changed while locating the source.' }; }
        element = findMessage();
        if (element && canonicalMessageText(element) === message.text) break;
      }
    }
    if (!element) { restoreFailedLookup?.(); return { ok: false, error: 'The source message could not be recovered within the lookup limit. The previous reading position was restored.' }; }
    if (!valid(token, conversation) || !element.isConnected || canonicalMessageText(element) !== message.text || messageIdentity(element, current)?.role !== message.role) {
      restoreFailedLookup?.();
      return { ok: false, error: 'The source message changed. Index the conversation again.' };
    }
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const html = element as HTMLElement;
    clearHighlight();
    const original = html.style.outline;
    html.style.outline = '3px solid #d8a64c';
    highlighted = { element: html, original, timer: setTimeout(clearHighlight, 1800) };
    return { ok: true };
  }

  return {
    start() {
      if (started) return;
      started = true;
      const Observer = (win as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
      observer = new Observer(() => { navigate(); schedule(); });
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-message-id', 'data-message-author-role', 'data-turn-id', 'data-turn-key', 'data-chatgpt-search-message-ids', 'data-chatgpt-search-unit-key', 'data-chatgpt-selection-message-id', 'data-chatgpt-selection-conversation-id', 'data-is-streaming', 'data-talvt-turn-state', 'aria-busy', 'class'] });
      win.addEventListener('popstate', navigate);
      navigationTimer = setInterval(navigate, 250);
      schedule();
    },
    stop() {
      started = false;
      cancel();
      observer?.disconnect();
      if (navigationTimer) clearInterval(navigationTimer);
      win.removeEventListener('popstate', navigate);
    },
    capture,
    async command(command) {
      navigate();
      if (command.kind === 'content/reset') {
        paused = true;
        newRun();
        return { ok: true };
      }
      if (command.kind === 'content/reindex') {
        if (!current) return { ok: false, error: 'Open a saved ChatGPT conversation first.' };
        paused = false;
        newRun();
        const token = generation;
        // Acknowledge immediately; long scans never hold Chrome's message port open.
        setTimeout(() => { if (token === generation && !paused) void fullIndex(); }, 0);
        return { ok: true };
      }
      return jump(command);
    },
  };
}
