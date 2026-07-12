import {
  anchors,
  capture,
  createLiveHydrator,
  jumpToSource,
} from "@gpt-sidekick/adapter-provider-chatgpt";
import { connectRouted } from "@gpt-sidekick/adapter-host-chrome/routed-rpc";
import {
  onJumpRequested,
  onReindexRequested,
  pushTranscript,
  reportIndexState,
  reportJumpResult,
  type IndexingState,
} from "@gpt-sidekick/core/service";

type ScrollPosition = { element: Element; top: number; left: number };

function conversationIdFromUrl(url: string): string | undefined {
  return url.match(/\/c\/([^/?#]+)/)?.[1];
}

/** Preserve every scrollable ancestor touched by turn.scrollIntoView(). */
function rememberScrollPositions(root: ParentNode): ScrollPosition[] {
  const firstTurn = root.querySelector(anchors.turn);
  const positions: ScrollPosition[] = [];
  let current = firstTurn?.parentElement;
  while (current) {
    if (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth) {
      positions.push({ element: current, top: current.scrollTop, left: current.scrollLeft });
    }
    current = current.parentElement;
  }
  const scrollingElement = document.scrollingElement;
  if (scrollingElement && !positions.some(({ element }) => element === scrollingElement)) {
    positions.push({
      element: scrollingElement,
      top: scrollingElement.scrollTop,
      left: scrollingElement.scrollLeft,
    });
  }
  return positions;
}

function restoreScrollPositions(positions: ScrollPosition[]): void {
  for (const { element, top, left } of positions) {
    element.scrollTo?.({ top, left, behavior: "instant" });
    // jsdom/older DOMs may expose scroll offsets without scrollTo.
    if (typeof element.scrollTo !== "function") {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }
}

/**
 * Live ChatGPT controller. Passive mutation capture keeps a growing chat fresh;
 * an explicit panel request switches to the bounded skeleton walk and actively
 * hydrates every turn. Both paths share idempotent store upserts.
 */
export default defineContentScript({
  matches: ["https://chatgpt.com/*"],
  main() {
    const rpc = connectRouted({ context: "content" });
    let running: "passive" | "full" | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queuedPassive = false;
    let queuedFull = false;
    let explicitResultConversation: string | undefined;

    const report = (state: IndexingState, conversationId?: string) => {
      void reportIndexState(rpc, state, conversationId).catch((err) => {
        console.debug("[gpt-sidekick] state report failed:", err);
      });
    };

    const runCapture = async (mode: "passive" | "full"): Promise<void> => {
      if (running) {
        if (mode === "full") queuedFull = true;
        else queuedPassive = true;
        return;
      }

      running = mode;
      const conversationId = conversationIdFromUrl(location.href);
      const expectedTurns = document.querySelectorAll(anchors.turn).length;
      if (conversationId !== explicitResultConversation && mode === "passive") {
        explicitResultConversation = undefined;
      }
      const savedScroll = mode === "full" ? rememberScrollPositions(document) : [];
      if (mode === "full") {
        report(
          {
            kind: "capturing",
            processed: 0,
            captured: 0,
            expected: expectedTurns,
            unstable: 0,
          },
          conversationId,
        );
      }

      try {
        const { events, state } = await capture({
          root: document,
          url: location.href,
          hydrateTurn: mode === "full" ? createLiveHydrator() : async () => {},
          onProgress:
            mode === "full"
              ? (progress) => report({ kind: "capturing", ...progress }, conversationId)
              : undefined,
        });

        if (state.kind === "failed") {
          report({ kind: "failed", reason: state.reason }, conversationId);
          return;
        }

        const unstable = state.kind === "partial" ? state.unstable.length : 0;
        if (events.length === 0) {
          report(
            {
              kind: "partial",
              captured: state.kind === "partial" ? state.captured : 0,
              expected: state.kind === "partial" ? state.expected : expectedTurns,
              messages: 0,
              items: 0,
              droppedNoEvidence: 0,
              unstable,
            },
            conversationId,
          );
          if (mode === "full") explicitResultConversation = conversationId;
          return;
        }

        if (mode === "full") {
          report(
            {
              kind: "indexing",
              captured: state.kind === "partial" ? state.captured : expectedTurns,
              expected: state.kind === "partial" ? state.expected : expectedTurns,
              unstable,
            },
            conversationId,
          );
        }

        const counts = await pushTranscript(rpc, events);
        const finalState: IndexingState =
          state.kind === "partial"
            ? {
                kind: "partial",
                captured: state.captured,
                expected: state.expected,
                messages: counts.messages,
                items: counts.items,
                droppedNoEvidence: counts.droppedNoEvidence,
                unstable,
              }
            : {
                kind: "ready",
                messages: counts.messages,
                items: counts.items,
                droppedNoEvidence: counts.droppedNoEvidence,
                unstable,
              };
        if (mode === "full" || explicitResultConversation !== conversationId) {
          report(finalState, conversationId);
        }
        if (mode === "full") explicitResultConversation = conversationId;

        console.debug(
          `[gpt-sidekick] ${mode} captured`,
          events.length,
          "→ indexed",
          counts,
          state,
        );
      } catch (err) {
        report(
          { kind: "failed", reason: err instanceof Error ? err.message : String(err) },
          conversationId,
        );
        console.debug("[gpt-sidekick] capture/push failed:", err);
      } finally {
        if (mode === "full") restoreScrollPositions(savedScroll);
        running = null;
        if (queuedFull) {
          queuedFull = false;
          void runCapture("full");
        } else if (queuedPassive) {
          queuedPassive = false;
          schedule();
        }
      }
    };

    function schedule(): void {
      if (running === "full") {
        queuedPassive = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void runCapture("passive"), 800);
    }

    onReindexRequested(rpc, () => {
      void runCapture("full");
    });
    onJumpRequested(rpc, (request) => {
      void jumpToSource({
        root: document,
        messageId: request.messageId,
        turnId: request.turnId,
      })
        .then((result) =>
          reportJumpResult(rpc, { requestId: request.requestId, status: result.status }),
        )
        .catch(() =>
          reportJumpResult(rpc, { requestId: request.requestId, status: "not-found" }),
        );
    });

    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const origPushState = history.pushState.bind(history);
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      origPushState(...args);
      explicitResultConversation = undefined;
      schedule();
    };
    window.addEventListener("popstate", () => {
      explicitResultConversation = undefined;
      schedule();
    });

    schedule();
  },
});
