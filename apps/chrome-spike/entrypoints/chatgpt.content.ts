/**
 * ChatGPT content-script seam — deliberately inert in M0.
 * M1 wires the provider adapter's scroll-and-accumulate capture here.
 */
export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  main() {
    // No capture yet (M1).
  },
});
