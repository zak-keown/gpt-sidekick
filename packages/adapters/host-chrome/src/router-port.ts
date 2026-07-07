import {
  createRouter,
  isAddress,
  type Address,
  type Link,
  type RoutedEnvelope,
  type Router,
} from "@gpt-sidekick/core/router";
import type { Envelope } from "@gpt-sidekick/core/protocol";

/**
 * Service-worker binding for core's pure `Router` (SPEC §13 targeted routing).
 *
 * Every content script and side panel connects here with `chrome.runtime.connect`.
 * The SW is the ONLY context holding all the links, so it is the sole relay: it
 * hands each envelope to just its addressed endpoint, never broadcasting. This
 * replaces the M0 `runtime.sendMessage` broadcast for content-bearing payloads.
 *
 * Identity — the trust hinge:
 *  - **Content scripts** are Chrome-attested. `port.sender.tab.id` is filled by
 *    the browser and cannot be spoofed by page/content code, so it becomes the
 *    link's `attested` address directly. A content port with no attested tab
 *    fails closed (disconnected).
 *  - **Side panels** are first-party extension pages with no `port.sender.tab`,
 *    so their identity is resolved by `resolvePanelIdentity` — see its doc for
 *    the deferred authoritative-assignment seam and the conditional guarantee.
 *
 * The declared `source` on incoming envelopes is ignored; core's router stamps
 * the attested one. Returns the `Router` so a caller may register an SW-local
 * endpoint later (e.g. a store owned by the SW) via
 * `router.addLink({ attested: { context: "sw" }, deliver })` — the store-location
 * decision is deliberately left to live-wiring (plans/M2-core-evidence.md).
 */

export const CONTENT_PORT = "gpt-sidekick:content";
export const PANEL_PORT = "gpt-sidekick:panel";

/** Deliver to a port, swallowing the "disconnected port object" throw Chrome
 *  raises when a panel/content context closes between a push and its
 *  `onDisconnect` firing. Without this a single dead target would abort the
 *  router's delivery loop and drop the message for everyone. `onDisconnect`
 *  unlinks the dead port moments later. */
function postSafely(port: chrome.runtime.Port, routed: RoutedEnvelope): void {
  try {
    port.postMessage(routed);
  } catch {
    // Port already torn down; nothing to deliver to.
  }
}

/** The slice of `chrome.runtime` this needs — injectable so tests fake it. */
type RuntimeLike = {
  id: string;
  onConnect: {
    addListener(callback: (port: chrome.runtime.Port) => void): void;
  };
};

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).id === "string" &&
    typeof (value as Envelope).kind === "string"
  );
}

/** Shape-check an inbound message. `source` is intentionally NOT validated — the
 *  router overwrites it with the attested identity, so a sender can omit or lie
 *  about it without effect. Only `target` and `envelope` are trusted-after-check. */
function isRoutedEnvelope(value: unknown): value is RoutedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const routed = value as { target?: unknown; envelope?: unknown };
  return isAddress(routed.target) && isEnvelope(routed.envelope);
}

/**
 * Resolve the tab a panel port represents — THE DEFERRED TRUST BOUNDARY (SPEC §13).
 *
 * A side panel is a first-party extension page whose `port.sender.tab` is
 * undefined, so today we accept the tab id it declares in its `hello`. The
 * no-cross-panel-leak guarantee is therefore CONDITIONAL on this value being
 * correct: a benign bug (racy `tabs.query`, a focus change mid-connect, a
 * multi-window setup) that yields the wrong tab id would route another tab's
 * transcript to this panel — the exact §13 leak, no attacker required.
 *
 * The authoritative fix — the SW assigning the tab id from the sidePanel/tab the
 * panel was opened for, rather than trusting the panel's claim — slots in HERE
 * without touching the router. Until then this is the ONE place a panel's claim
 * is trusted, kept deliberately narrow. Tracked in plans/M2-core-evidence.md.
 */
function resolvePanelIdentity(
  _port: chrome.runtime.Port,
  hello: unknown,
): Address | undefined {
  if (
    typeof hello === "object" &&
    hello !== null &&
    (hello as { kind?: unknown }).kind === "hello" &&
    typeof (hello as { tabId?: unknown }).tabId === "number"
  ) {
    return { context: "panel", tabId: (hello as { tabId: number }).tabId };
  }
  return undefined;
}

export function createSwPortRouter(
  runtime: RuntimeLike = chrome.runtime,
): Router {
  const router = createRouter();

  runtime.onConnect.addListener((port) => {
    // Defense-in-depth: only our own extension's contexts. External pages can't
    // connect at all without `externally_connectable` (which we don't set); this
    // guards a future manifest change from silently opening the router.
    if (port.sender?.id !== runtime.id) {
      port.disconnect();
      return;
    }

    if (port.name === CONTENT_PORT) {
      const tabId = port.sender?.tab?.id;
      if (typeof tabId !== "number") {
        port.disconnect(); // fail closed: content script with no attested tab
        return;
      }
      bindKnownLink(router, port, { context: "content", tabId });
      return;
    }

    if (port.name === PANEL_PORT) {
      bindPanelLink(router, port);
      return;
    }

    port.disconnect(); // unknown port name
  });

  return router;
}

/** Bind a link whose identity is known at connect time (content scripts). */
function bindKnownLink(
  router: Router,
  port: chrome.runtime.Port,
  attested: Address,
): void {
  const link: Link = {
    attested,
    deliver: (routed) => postSafely(port, routed),
  };
  const unlink = router.addLink(link);
  port.onMessage.addListener((message: unknown) => {
    if (isRoutedEnvelope(message)) router.route(link, message);
  });
  port.onDisconnect.addListener(() => unlink());
}

/** Bind a panel link once its first message establishes a valid identity. */
function bindPanelLink(router: Router, port: chrome.runtime.Port): void {
  let link: Link | undefined;
  let unlink: (() => void) | undefined;

  port.onMessage.addListener((message: unknown) => {
    if (!link) {
      const attested = resolvePanelIdentity(port, message);
      if (!attested) {
        port.disconnect(); // first message must be a valid hello
        return;
      }
      link = { attested, deliver: (routed) => postSafely(port, routed) };
      unlink = router.addLink(link);
      return; // the hello carries no envelope
    }
    if (isRoutedEnvelope(message)) router.route(link, message);
  });

  port.onDisconnect.addListener(() => unlink?.());
}
