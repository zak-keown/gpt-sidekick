import { createChromeRpc } from "@gpt-sidekick/adapter-host-chrome";

/**
 * Thin SW router. For M0 it services the `echo` kind itself; later
 * milestones relay envelopes between the side panel and content scripts.
 */
export default defineBackground(() => {
  const rpc = createChromeRpc();
  rpc.handle("echo", (payload) => payload);

  // Open the side panel when the toolbar action is clicked (manual check
  // path on chatgpt.com; the e2e drives the panel page by URL instead).
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
