import { createChromeRpc } from "@gpt-sidekick/adapter-host-chrome";
import { createSwPortRouter } from "@gpt-sidekick/adapter-host-chrome/router";
import { createSwRoutedRpc } from "@gpt-sidekick/adapter-host-chrome/routed-rpc";
import { registerStoreService } from "@gpt-sidekick/core/service";
import { RulesExtractor } from "@gpt-sidekick/core/extractor";
import { DexieTranscriptStore } from "@gpt-sidekick/adapter-storage-dexie";

/**
 * Service worker: the M0 echo handler plus the SW-owned store pipeline (§13, §7).
 * The SW owns the store so captures survive the panel being closed.
 */
export default defineBackground(() => {
  const rpc = createChromeRpc();
  rpc.handle("echo", (payload) => payload);

  // §13 targeted routing + the SW-owned store. Content scripts push captured
  // transcript over runtime.connect; the SW upserts → extracts → persists (Dexie,
  // durable across SW restarts) and serves reads back to the panel — each payload
  // reaching ONLY its own tab, never broadcast. No clients connect until capture
  // is wired (gated on real-anchor validation); standing the pipeline up now
  // proves it loads in the built extension. Echo stays on broadcast (a public
  // string), keeping the M0 panel⇄SW e2e round-trip untouched.
  const router = createSwPortRouter();
  const swRpc = createSwRoutedRpc(router);
  registerStoreService(swRpc, new DexieTranscriptStore(), RulesExtractor);

  // Open the side panel when the toolbar action is clicked (manual check
  // path on chatgpt.com; the e2e drives the panel page by URL instead).
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
