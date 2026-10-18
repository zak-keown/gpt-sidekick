// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App, type PanelTransport } from '../src/panel/App';
import { demoState } from '../src/panel/demo';
import type { PanelState } from '../src/core/types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function transportFor(state = demoState): PanelTransport {
  return { getWindowId: vi.fn(async () => 42), request: vi.fn(async request => request.kind === 'panel/state' ? state : { ok: true as const }), copy: vi.fn(async () => {}) };
}
describe('source outline panel', () => {
  it('keeps source lookup failures visible through refresh without discarding the outline', async () => {
    const transport = transportFor();
    transport.request = vi.fn(async request => request.kind === 'panel/state' ? demoState : { ok: false as const, error: 'Source lookup reached its limit.' });
    render(<App transport={transport} pollMs={100000} />);
    await screen.findByText('Planning a quieter reading companion');
    fireEvent.click(screen.getAllByRole('button', { name: 'View source' })[0]!);
    await screen.findByText('Source lookup reached its limit.');
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(transport.request).toHaveBeenCalledTimes(4));
    expect(screen.getByText('Source lookup reached its limit.')).toBeTruthy();
    expect(screen.getByText('Planning a quieter reading companion')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Source lookup reached its limit.')).toBeNull();
  });

  it('binds requests to its window, filters quotes and jumps by item identity', async () => {
    const transport = transportFor();
    render(<App transport={transport} pollMs={100000} />);
    await screen.findByText('Planning a quieter reading companion');
    expect(transport.request).toHaveBeenCalledWith({ kind: 'panel/state', windowId: 42 });
    fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'original wording' } });
    expect(screen.getByText('Preserve the original wording.')).toBeTruthy();
    expect(screen.queryByText('Keep the conversation on this device.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    await waitFor(() => expect(transport.request).toHaveBeenCalledWith({ kind: 'panel/jump', windowId: 42, itemId: 'demo-6' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Preserve the original wording.' }));
    await waitFor(() => expect(transport.copy).toHaveBeenCalledWith(expect.stringContaining('The quote should preserve the original wording.')));
  });

  it('requires inline confirmation and cancels it when the active conversation changes', async () => {
    const transport = transportFor();
    let current = demoState;
    transport.request = vi.fn(async request => request.kind === 'panel/state' ? current : { ok: true as const });
    render(<App transport={transport} pollMs={100000} />);
    await screen.findByText('Planning a quieter reading companion');
    fireEvent.click(screen.getByRole('button', { name: 'Delete this outline' }));
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Delete this conversation’s saved messages and outline?')).toBeTruthy();
    current = { supported: false, snapshot: null, tabId: 9 };
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('Open a ChatGPT conversation');
    expect(screen.queryByText('Delete this conversation’s saved messages and outline?')).toBeNull();
  });

  it('clears stale source content when state reads fail', async () => {
    const transport = transportFor();
    let fail = false;
    transport.request = vi.fn(async () => { if (fail) throw new Error('Worker disconnected'); return demoState; });
    render(<App transport={transport} pollMs={100000} />);
    await screen.findByText('Planning a quieter reading companion');
    fail = true;
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('Worker disconnected');
    expect(screen.queryByText('Keep the conversation on this device.')).toBeNull();
  });

  it('does not overlap reads and ignores a read that predates a deletion', async () => {
    const transport = transportFor();
    let resolveRead!: (state: PanelState) => void;
    let reads = 0;
    transport.request = vi.fn(async request => {
      if (request.kind !== 'panel/state') return { ok: true as const };
      ++reads;
      if (reads === 1) return demoState;
      return new Promise<PanelState>(resolve => { resolveRead = resolve; });
    });
    render(<App transport={transport} pollMs={100000} />);
    await screen.findByText('Planning a quieter reading companion');
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this outline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this conversation' }));
    await screen.findByText('Saved data deleted.');
    resolveRead(demoState);
    await waitFor(() => expect(screen.queryByText('Keep the conversation on this device.')).toBeNull());
  });

  it('labels preview data and never sends extension commands in demo mode', async () => {
    const transport = transportFor();
    render(<App demo transport={transport} />);
    expect(screen.getByText('Preview with sample conversation data')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'View source' })[0]!);
    await screen.findByText('Preview only. Open Sidekick on ChatGPT to use this action.');
    expect(transport.getWindowId).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('clears old sources immediately on a tab switch and ignores the prior pending read', async () => {
    const transport = transportFor();
    let changed!: () => void;
    let resolveRead!: (state: PanelState) => void;
    let reads = 0;
    const unsubscribe = vi.fn();
    transport.subscribe = vi.fn((_windowId, onChange) => { changed = onChange; return unsubscribe; });
    transport.request = vi.fn(async request => {
      if (request.kind !== 'panel/state') return { ok: true as const };
      ++reads;
      if (reads === 1) return demoState;
      if (reads === 2) return new Promise<PanelState>(resolve => { resolveRead = resolve; });
      return { supported: false, snapshot: null, tabId: 123 };
    });
    const view = render(<App transport={transport} pollMs={100000} />);
    await screen.findByText('Planning a quieter reading companion');
    expect(transport.subscribe).toHaveBeenCalledWith(42, expect.any(Function));
    fireEvent(document, new Event('visibilitychange'));
    changed();
    await waitFor(() => expect(screen.queryByText('Keep the conversation on this device.')).toBeNull());
    resolveRead(demoState);
    await screen.findByText('Open a ChatGPT conversation');
    expect(screen.queryByText('Keep the conversation on this device.')).toBeNull();
    view.unmount();
    await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });
});
