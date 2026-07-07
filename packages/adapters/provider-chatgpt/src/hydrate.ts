import { isHydrated } from "./capture";

/**
 * The live content-script hydrator (SPEC §5.2 step 2). Scrolls a turn into view
 * to trigger the virtualizer, then awaits rehydration — resolving only when the
 * turn is `isHydrated` (a `[data-message-id]` node with **non-empty canonical
 * text**), NOT on mere node presence. A `MutationObserver` watches for the
 * paint; a timeout makes it **give up by resolving** (never rejecting), so a
 * turn that won't hydrate flows into `capture()`'s `unstable` accounting rather
 * than aborting the whole pass.
 *
 * This is `capture()`'s injected `hydrateTurn` on the real page; tests inject a
 * fake. Wiring it into the content script + routing capture output to the panel
 * is the M2 handoff (SPEC §13 targeted-routing gate).
 */
export function createLiveHydrator(
  options: { timeoutMs?: number } = {},
): (turn: Element) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3_000;

  return (turn) =>
    new Promise<void>((resolve) => {
      if (isHydrated(turn)) {
        resolve();
        return;
      }

      // Guarded: the live page implements scrollIntoView; jsdom does not.
      if (typeof turn.scrollIntoView === "function") {
        turn.scrollIntoView({ block: "center" });
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };

      const observer = new MutationObserver(() => {
        if (isHydrated(turn)) finish();
      });
      observer.observe(turn, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      const timer = setTimeout(finish, timeoutMs);
    });
}
