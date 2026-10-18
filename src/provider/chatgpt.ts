import { conversationIdFromUrl, type CaptureBatch, type CommandResult, type ContentCommand, type Role, type TranscriptMessage } from '../core/types';

const messageSelector = '[data-message-author-role]';
const excluded = 'button,script,style,noscript,svg,[hidden],[aria-hidden="true"],[role="toolbar"],.sr-only,[data-sidekick-highlight]';
const blocks = new Set(['P', 'DIV', 'PRE', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'TR']);

/** The same deterministic canonical text is used for capture and evidence checks. */
export function canonicalMessageText(message: Element): string {
  if (message.closest('[hidden],[aria-hidden="true"]')) return '';
  const content = message.querySelector('[data-message-content],.markdown,.whitespace-pre-wrap') ?? message;
  function visit(node: Node, pre = false): string {
    if (node.nodeType === 3) return pre ? node.textContent ?? '' : (node.textContent ?? '').replace(/[\t\r\n ]+/g, ' ');
    if (node.nodeType !== 1) return '';
    const element = node as HTMLElement;
    if (element.matches(excluded)) return '';
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style?.display === 'none' || style?.visibility === 'hidden') return '';
    if (element.tagName === 'BR') return '\n';
    // Code widgets often put a language label and copy button beside the PRE.
    if (element.tagName !== 'PRE' && !element.querySelector('pre') && element.querySelector('button') && element.parentElement?.querySelector(':scope > pre')) return '';
    const isPre = pre || element.tagName === 'PRE' || element.classList.contains('whitespace-pre-wrap') || style?.whiteSpace.startsWith('pre') === true;
    const text = Array.from(element.childNodes, child => visit(child, isPre)).join('');
    if (element.tagName === 'PRE' && !pre) return `\n\`\`\`\n${text}\n\`\`\`\n`;
    return !pre && blocks.has(element.tagName) ? `\n${text}\n` : text;
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
      ...wrappers().map(element => ({ element, attribute: 'data-turn-id', value: element.getAttribute('data-turn-id') })),
      ...Array.from(doc.querySelectorAll(messageSelector), element => ({ element, attribute: 'data-message-id', value: element.getAttribute('data-message-id') })),
    ];
  }

  function wrappers(): Element[] {
    return Array.from(doc.querySelectorAll('[data-turn-id]')).filter(element => !element.parentElement?.closest('[data-turn-id]'));
  }

  function isStreaming(): boolean {
    return !!doc.querySelector('[data-is-streaming="true"],[aria-busy="true"],.result-streaming,[data-testid="stop-button"],[aria-label="Stop generating"]');
  }

  function turnIds(turns: Element[]): string[] {
    return turns.map(turn => turn.getAttribute('data-turn-id') ?? '');
  }

  function sameTurns(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  function readTurn(turn: Element, ordinal: number): { rows: TranscriptMessage[]; unstable: number } {
    const candidates = Array.from(turn.querySelectorAll(messageSelector));
    if (turn.matches(messageSelector)) candidates.unshift(turn);
    const rows: TranscriptMessage[] = [];
    let unstable = 0;
    const turnId = turn.getAttribute('data-turn-id') ?? undefined;
    for (const [index, element] of candidates.entries()) {
      const id = element.getAttribute('data-message-id');
      const role = element.getAttribute('data-message-author-role');
      const text = canonicalMessageText(element);
      if (!id || !role || !['user', 'assistant', 'system', 'tool'].includes(role) || !text || !current) {
        unstable++;
        continue;
      }
      rows.push({ id, conversationId: current, role: role as Role, text, ordinal: ordinal * 100 + index, ...(turnId ? { turnId } : {}) });
    }
    return { rows, unstable };
  }

  function emit(mode: CaptureBatch['mode'], phase: CaptureBatch['phase'], capturedTurns: number, totalTurns: number, unstableMessages: number, error?: string): void {
    if (!current || paused) return;
    const token = generation;
    const batch: CaptureBatch = {
      conversationId: current,
      title: doc.title.replace(/\s*[-–|]\s*ChatGPT\s*$/, '').trim() || 'Conversation',
      messages: Array.from(messages.values()).sort((a, b) => a.ordinal - b.ordinal),
      mode, phase, progress: { capturedTurns, totalTurns, unstableMessages }, runId, sequence: ++sequence,
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
      else if (!result.unstable && coverageEstablished && previouslyCapturedTurns.has(turn.getAttribute('data-turn-id') ?? undefined)) captured++;
      if (result.rows.length && !result.unstable) {
        // Regenerating a turn can replace its stable message ID. Retain only
        // the current branch once that turn is mounted and readable again.
        const ids = new Set(result.rows.map(row => row.id));
        for (const [id, message] of messages) {
          if (message.turnId === turn.getAttribute('data-turn-id') && !ids.has(id)) messages.delete(id);
        }
      }
      for (const row of result.rows) messages.set(row.id, row);
    }
    // Full indexing establishes coverage. A subsequent stable streaming update
    // can finish that run without demoting an already complete transcript.
    const complete = coverageEstablished && captured === turns.length && !unstable && !isStreaming();
    emit('passive', complete ? 'ready' : 'partial', captured, turns.length, unstable,
      complete ? undefined : isStreaming() ? 'The conversation is still streaming.' :
        turns.length ? 'Visible messages captured. Run full indexing to check all available turns.' : 'No persistent conversation turns are available.');
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
          const turnId = turn.getAttribute('data-turn-id');
          const live = wrappers().find(candidate => candidate.getAttribute('data-turn-id') === turnId) ?? turn;
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
      if (covered) indexedTurnIds = turnIds(turns);
      const streaming = isStreaming();
      const complete = covered && !streaming;
      emit('full', complete ? 'ready' : 'partial', captured, turns.length, unstable,
        error ?? (complete ? undefined : streaming ? 'The conversation is still streaming.' : 'Some turns are unavailable, empty, or lack stable message IDs.'));
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
    const findMessage = () => Array.from(doc.querySelectorAll(messageSelector)).find(element => element.getAttribute('data-message-id') === message.id);
    let element = findMessage();
    if (!element && message.turnId) {
      const turn = wrappers().find(candidate => candidate.getAttribute('data-turn-id') === message.turnId);
      if (turn) {
        turn.scrollIntoView?.({ block: 'center', behavior: 'instant' });
        for (let attempt = 0; attempt < 3 && !element; attempt++) {
          await wait();
          if (!valid(token, conversation)) return { ok: false, error: 'Conversation changed while locating the source.' };
          element = findMessage();
        }
      }
    }
    if (!element) return { ok: false, error: 'The source message is not currently available.' };
    if (!valid(token, conversation) || canonicalMessageText(element) !== message.text || element.getAttribute('data-message-author-role') !== message.role) {
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
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-message-id', 'data-message-author-role', 'data-turn-id', 'data-is-streaming', 'aria-busy', 'class'] });
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
