import { createChatGPTProvider } from './provider/chatgpt';
import type { ContentCommand } from './core/types';

const provider = createChatGPTProvider({
  document,
  window,
  send: batch => chrome.runtime.sendMessage({ kind: 'content/capture', batch }),
});

chrome.runtime.onMessage.addListener((value: unknown, _sender, respond) => {
  if (!value || typeof value !== 'object' || !('kind' in value)) return;
  if (value.kind !== 'content/reindex' && value.kind !== 'content/cancel' && value.kind !== 'content/reset' && value.kind !== 'content/jump') return;
  void provider.command(value as ContentCommand).then(respond, () => respond({ ok: false, error: 'The content command failed.' }));
  return true;
});

provider.start();
