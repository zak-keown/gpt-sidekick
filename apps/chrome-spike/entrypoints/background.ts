import { createChromeRpc } from "@gpt-sidekick/adapter-host-chrome";
import { createSwPortRouter } from "@gpt-sidekick/adapter-host-chrome/router";

/**
 * Thin SW router. It services the M0 `echo` kind itself and, from M2b on, is the
 * relay for content-bearing payloads between content scripts and the side panel.
 */
export default defineBackground(() => {
  const rpc = createChromeRpc();
  rpc.handle("echo", (payload) => payload);

  // §13 targeted routing. Content scripts and the side panel connect here via
  // runtime.connect so a transcript payload reaches ONLY its own tab's panel,
  // never broadcast. No clients connect until M2b's live wiring lands; standing
  // it up now proves the SW router loads in the built extension. The echo path
  // above stays on broadcast — fine for a public string, and it keeps the M0
  // panel⇄SW e2e round-trip untouched.
  createSwPortRouter();

  // Open the side panel when the toolbar action is clicked (manual check
  // path on chatgpt.com; the e2e drives the panel page by URL instead).
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
