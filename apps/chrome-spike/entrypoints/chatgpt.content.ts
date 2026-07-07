import { capture } from "@gpt-sidekick/adapter-provider-chatgpt";
import { connectRouted } from "@gpt-sidekick/adapter-host-chrome/routed-rpc";
import { pushTranscript } from "@gpt-sidekick/core/service";

/**
 * ChatGPT capture (SPEC §5). Passive scroll-accumulate: captures only the turns
 * currently hydrated (no forced scroll), pushing them over the §13 router to the
 * SW-owned store. As ChatGPT's virtualizer paints more turns on scroll, a
 * debounced MutationObserver re-captures and the outline accumulates. Idempotent
 * (dedup by messageId + upsert), so re-capture is always safe. Content identity
 * is Chrome-attested to the SW router — no self-declared tab id.
 */
export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  main() {
    const rpc = connectRouted({ context: "content" });
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const runCapture = async (): Promise<void> => {
      if (running) {
        schedule(); // a pass is in flight — retry once it settles
        return;
      }
      running = true;
      try {
        const { events, state } = await capture({
          root: document,
          url: location.href,
          hydrateTurn: async () => {}, // passive: only already-painted turns
        });
        if (events.length > 0) {
          const counts = await pushTranscript(rpc, events);
          // Load-test bisect: capture count is the DOM side; the returned counts
          // are the SW's reply, proving the routed round-trip + index ran.
          console.debug("[gpt-sidekick] captured", events.length, "→ indexed", counts, state);
        }
      } catch (err) {
        console.debug("[gpt-sidekick] capture/push failed:", err);
      } finally {
        running = false;
      }
    };

    // Trailing debounce on DOM quiescence: ChatGPT streams tokens, so capture
    // AFTER the DOM settles (~800ms idle) to avoid grabbing partial assistant
    // text mid-stream. (A mid-stream capture self-heals via upsert + CAS re-index,
    // but debouncing avoids a janky transient outline.)
    function schedule(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void runCapture(), 800);
    }

    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // SPA navigation: ChatGPT routes via history.pushState (no reload, no
    // popstate), so patch pushState + listen popstate to re-capture on a new
    // conversation (the /c/<id> in the URL is the conversation key).
    const origPushState = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      origPushState(...args);
      schedule();
    };
    window.addEventListener("popstate", schedule);

    schedule(); // initial pass — sparse at document_idle; the observer fills in
  },
});
