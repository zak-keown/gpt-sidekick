import type { Category, PanelState } from '../core/types';

export const demoState: PanelState = {
  supported: true, tabId: 1,
  snapshot: {
    conversationId: 'demo', title: 'Planning a quieter reading companion',
    phase: 'partial', updatedAt: '2026-10-18T16:00:00Z', droppedCandidates: 0,
    progress: { capturedTurns: 18, totalTurns: 24, unstableMessages: 1 },
    messages: [],
    items: [
      ['decision', 'Keep the conversation on this device.', 'We decided to keep conversation data on this device.'],
      ['action', 'Test navigation in a long conversation.', 'Next, test source navigation in a long conversation.'],
      ['question', 'How should missing messages be shown?', 'How should we show messages that are no longer loaded?'],
      ['artifact', 'Draft the first milestone.', 'The first milestone is an outline with exact source evidence.'],
      ['code', 'Use one clear capture boundary.', 'const capture = readVisibleConversation();'],
      ['correction', 'Use the active window’s conversation.', 'Correction: follow the active tab in the panel’s own window.'],
      ['note', 'Preserve the original wording.', 'The quote should preserve the original wording.'],
    ].map(([category, title, quote], i) => ({ id: `demo-${i}`, category: category as Category, title: title!, evidence: { messageId: `m-${i}`, quote: quote!, start: 0, end: quote!.length } })),
  },
};
