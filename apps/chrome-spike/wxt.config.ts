import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

export default defineConfig({
  manifest: {
    name: "GPT-Sidekick (spike)",
    // Least-privilege for M0 (Codex adversarial review, 2026-07-07): only the
    // side panel. The chatgpt.com content-script seam (entrypoints/chatgpt.content.ts)
    // carries its own host access via its match pattern and stays inert.
    // `scripting`, `storage`, `unlimitedStorage`, and an explicit host_permissions
    // entry return in the milestone that first uses each (storage → M2;
    // host_permissions → M1, for targeted tabs.sendMessage routing per SPEC §13).
    permissions: ["sidePanel"],
    action: {
      default_title: "GPT-Sidekick",
    },
  },
  vite: () => ({
    plugins: [preact(), vanillaExtractPlugin()],
  }),
});
