import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  manifest: {
    name: "GPT-Sidekick (spike)",
    // Least-privilege: only the side panel. The chatgpt.com content-script seam
    // (entrypoints/chatgpt.content.ts) carries its own host access via its match
    // pattern and stays inert until M2b. §13 targeted routing uses
    // `runtime.connect` (intra-extension) — it needs NO `host_permissions` and no
    // `tabs`/`tabs.sendMessage` permission; the content-script match pattern is
    // the only host access required. `storage`/`unlimitedStorage` return in M2b's
    // live wiring when the Dexie store is first persisted from the extension.
    permissions: ["sidePanel"],
    action: {
      default_title: "GPT-Sidekick",
    },
  },
  vite: () => ({
    plugins: [preact(), vanillaExtractPlugin()],
  }),
});
