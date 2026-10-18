export const categories = ['decision', 'action', 'question', 'artifact', 'code', 'correction', 'note'] as const;
export type Category = (typeof categories)[number];
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type Phase = 'idle' | 'capturing' | 'ready' | 'partial' | 'failed';

export interface TranscriptMessage {
  id: string;
  conversationId: string;
  role: Role;
  text: string;
  ordinal: number;
  turnId?: string;
  /** Approximate viewport hint only; identity and canonical text still decide jumps. */
  scrollAnchor?: { top: number; height: number };
}

export interface Evidence {
  messageId: string;
  quote: string;
  start: number;
  end: number;
}

export interface OutlineItem {
  id: string;
  category: Category;
  title: string;
  evidence: Evidence;
}

export interface CaptureProgress {
  capturedTurns: number;
  totalTurns: number;
  unstableMessages: number;
  coverage?: 'mounted' | 'traversed';
}

export interface CaptureBatch {
  conversationId: string;
  title: string;
  messages: TranscriptMessage[];
  phase: Exclude<Phase, 'idle'>;
  progress: CaptureProgress;
  error?: string;
  runId: string;
  sequence: number;
  mode: 'passive' | 'full';
}

export interface Snapshot {
  conversationId: string;
  title: string;
  messages: TranscriptMessage[];
  items: OutlineItem[];
  phase: Phase;
  progress: CaptureProgress;
  updatedAt: string;
  droppedCandidates: number;
  error?: string;
}

export interface PanelState {
  tabId?: number;
  supported: boolean;
  snapshot: Snapshot | null;
  error?: string;
}

export type PanelRequest =
  | { kind: 'panel/state'; windowId: number }
  | { kind: 'panel/reindex'; windowId: number }
  | { kind: 'panel/jump'; windowId: number; itemId: string }
  | { kind: 'panel/delete'; windowId: number }
  | { kind: 'panel/delete-all'; windowId: number };

export type ContentEvent = { kind: 'content/capture'; batch: CaptureBatch };
export type ContentCommand =
  | { kind: 'content/reindex' }
  | { kind: 'content/jump'; conversationId: string; message: TranscriptMessage; evidence: Evidence }
  | { kind: 'content/reset' };
export type CommandResult = { ok: true } | { ok: false; error: string };

export function conversationIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com') return null;
    return /^\/c\/([a-zA-Z0-9-]+)\/?$/.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
