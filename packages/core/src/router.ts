/**
 * Attested, firewalled message routing (SPEC §13 — the [M1-BLOCKING] gate).
 *
 * The M0 RPC rides `chrome.runtime.sendMessage` *broadcast*: a payload reaches
 * every extension context's memory. That is harmless for an echo string but a
 * cross-tenant leak once real transcript/outline payloads flow — tab A's chat
 * would land in tab B's side panel. This module is the fix: a pure router that
 * lives in the service worker (the only context with the full set of connected
 * links) and relays each envelope to *only* its addressed endpoint.
 *
 * Three trust properties, all enforced here and tested headless:
 *  1. **Attested source.** The router stamps every message with the identity the
 *     transport vouched for (`Link.attested`), ignoring whatever `source` the
 *     sender declared — you cannot forge who you are.
 *  2. **Cross-tab firewall (`canSend`).** A content script may address only the
 *     sw and its OWN tab's panel; it can never reach another tab's panel.
 *  3. **Targeted delivery.** A message is handed to the link(s) whose attested
 *     address equals the target — never broadcast.
 *
 * Pure and host-free (core has no DOM/chrome types). The chrome binding —
 * deriving `Link.attested` from `port.sender` and wiring `deliver` to
 * `port.postMessage` — lives in the host-chrome adapter. `tabId` here is an
 * abstract routing scope (one browser tab = one conversation surface), not a
 * dependency on `chrome.tabs`.
 *
 * SCOPE OF THE GUARANTEE. Property 1 is unconditional for content scripts:
 * their tab id is Chrome-attested and unspoofable. Property 2/3 are
 * unconditional given correct attested addresses. The residual is *panel*
 * identity: a side panel is a first-party extension page with no
 * `port.sender.tab`, so the adapter must resolve its tab id another way (today,
 * a first-party claim). The no-cross-panel-leak guarantee is therefore
 * conditional on that panel tab id being correct — see the adapter's
 * `resolvePanelIdentity` and plans/M2-core-evidence.md.
 */

import type { Envelope } from "./protocol";

/**
 * A logical endpoint in the extension's messaging topology. `tabId` is an
 * abstract routing scope, NOT `chrome.tabs` — core stays host-free.
 */
export type Address =
  | { readonly context: "sw" }
  | { readonly context: "content"; readonly tabId: number }
  | { readonly context: "panel"; readonly tabId: number };

/** An RPC envelope plus its routing metadata. */
export type RoutedEnvelope = {
  /**
   * On the wire this is the sender's *claim*; on ingress the router overwrites
   * it with the sending link's attested identity, so a recipient always sees a
   * trustworthy source (and can reply to it safely).
   */
  readonly source: Address;
  readonly target: Address;
  readonly envelope: Envelope;
};

/** A connected endpoint the router can deliver to. */
export type Link = {
  /**
   * The identity the transport vouches for. For content scripts this is
   * Chrome-attested (`port.sender.tab.id`) and unspoofable; for panels it is
   * resolved by the adapter (see module doc). Never taken from message bodies.
   */
  readonly attested: Address;
  /** Hand a routed envelope to this endpoint (adapter wires `port.postMessage`). */
  deliver: (routed: RoutedEnvelope) => void;
};

export type RoutingResult =
  | { readonly ok: true; readonly delivered: number }
  | { readonly ok: false; readonly reason: "unauthorized-target" | "no-route" };

export interface Router {
  /** Register a connected endpoint; returns an unlink fn for its disconnect. */
  addLink(link: Link): () => void;
  /** Relay one envelope from `from`, using `from.attested` as the true source. */
  route(from: Link, routed: RoutedEnvelope): RoutingResult;
}

/** Structural equality on addresses. Same non-sw context requires equal tabId —
 *  the load-bearing check that keeps panel@7 and panel@3 distinct. */
export function addressEquals(a: Address, b: Address): boolean {
  if (a.context !== b.context) return false;
  return a.context === "sw" || b.context === "sw" ? true : a.tabId === b.tabId;
}

/**
 * The cross-tab firewall (SPEC §13). Which targets may a source reach:
 *  - `sw` → anywhere (the trusted relay).
 *  - `content@t` → `sw` or `panel@t` only (its own tab's panel).
 *  - `panel@t` → `sw` or `content@t` only (its own tab's content script).
 * A content script therefore can never address another tab's panel, so a
 * transcript payload cannot cross tabs. Weakening this to "always true" is the
 * revert that reds the isolation test.
 */
export function canSend(source: Address, target: Address): boolean {
  if (source.context === "sw" || target.context === "sw") return true;
  // Both non-sw: same tab, opposite role (content <-> panel) only.
  return source.tabId === target.tabId && source.context !== target.context;
}

/** Validates an unknown value is a well-formed `Address` (adapter fail-closed). */
export function isAddress(value: unknown): value is Address {
  if (typeof value !== "object" || value === null) return false;
  const a = value as { context?: unknown; tabId?: unknown };
  if (a.context === "sw") return true;
  if (a.context === "content" || a.context === "panel") {
    return typeof a.tabId === "number";
  }
  return false;
}

export function createRouter(): Router {
  const links = new Set<Link>();
  return {
    addLink(link) {
      links.add(link);
      return () => {
        links.delete(link);
      };
    },
    route(from, routed) {
      const source = from.attested; // attested, never the declared source
      if (!canSend(source, routed.target)) {
        return { ok: false, reason: "unauthorized-target" };
      }
      const stamped: RoutedEnvelope = {
        source,
        target: routed.target,
        envelope: routed.envelope,
      };
      let delivered = 0;
      for (const link of links) {
        if (addressEquals(link.attested, routed.target)) {
          link.deliver(stamped);
          delivered++;
        }
      }
      return delivered > 0
        ? { ok: true, delivered }
        : { ok: false, reason: "no-route" };
    },
  };
}
