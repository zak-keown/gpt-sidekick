import { BackgroundController } from './background/controller';
import { IndexedSnapshotStore } from './background/storage';
import { conversationIdFromUrl } from './core/types';

const controller = new BackgroundController({
  runtimeId: chrome.runtime.id,
  panelUrl: chrome.runtime.getURL('sidepanel.html'),
  queryTabs: query => chrome.tabs.query(query),
  getTab: id => chrome.tabs.get(id),
  send: (id, command) => chrome.tabs.sendMessage(id, command, { frameId: 0 }),
}, new IndexedSnapshotStore());

// MV3 listeners must be registered during initial synchronous worker evaluation.
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  void controller.handle(message, sender).then(respond);
  return true;
});

async function configureTab(tabId: number, url: string): Promise<void> {
  await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: conversationIdFromUrl(url) !== null });
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'complete') void configureTab(tabId, tab.url ?? '').catch(() => undefined);
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => configureTab(tab.id!, tab.url ?? ''))));
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
