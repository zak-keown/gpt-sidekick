import { describe, expect, it } from "vitest";
import {
  addressEquals,
  canSend,
  createRouter,
  isAddress,
  type Address,
  type Link,
  type RoutedEnvelope,
} from "./router";
import type { Envelope } from "./protocol";

const env = (kind = "pushTranscript", payload: unknown = "x"): Envelope => ({
  id: "e1",
  kind,
  payload,
});

/** A link that records everything delivered to it — the recipient's memory. */
function sink(attested: Address): Link & { received: RoutedEnvelope[] } {
  const received: RoutedEnvelope[] = [];
  return { attested, deliver: (r) => received.push(r), received };
}

const content = (tabId: number): Address => ({ context: "content", tabId });
const panel = (tabId: number): Address => ({ context: "panel", tabId });

describe("addressEquals / canSend — the trust predicates", () => {
  it("distinguishes addresses by tabId (the anti-cross-tab check)", () => {
    expect(addressEquals(panel(7), panel(7))).toBe(true);
    expect(addressEquals(panel(7), panel(3))).toBe(false);
    expect(addressEquals(panel(7), content(7))).toBe(false);
    expect(addressEquals({ context: "sw" }, { context: "sw" })).toBe(true);
    expect(addressEquals({ context: "sw" }, panel(7))).toBe(false);
  });

  it("firewalls cross-tab and same-role traffic (SPEC §13)", () => {
    // sw is the trusted relay: it may reach anything.
    expect(canSend({ context: "sw" }, panel(7))).toBe(true);
    expect(canSend({ context: "sw" }, content(3))).toBe(true);
    // A content script may reach only the sw and its OWN tab's panel.
    expect(canSend(content(7), { context: "sw" })).toBe(true);
    expect(canSend(content(7), panel(7))).toBe(true);
    expect(canSend(content(7), panel(3))).toBe(false); // cross-tab leak — blocked
    expect(canSend(content(7), content(7))).toBe(false); // same role — no path
    // The reply direction must be open too, or acks silently time out.
    expect(canSend(panel(7), content(7))).toBe(true);
    expect(canSend(panel(7), panel(3))).toBe(false);
  });
});

describe("Router.route — attested source, firewalled, targeted delivery", () => {
  it("delivers to the addressed panel and to no other panel (isolation)", () => {
    const router = createRouter();
    const panel7 = sink(panel(7));
    const panel3 = sink(panel(3));
    const content7: Link = { attested: content(7), deliver: () => {} };
    router.addLink(panel7);
    router.addLink(panel3);
    router.addLink(content7);

    const result = router.route(content7, {
      source: content(7),
      target: panel(7),
      envelope: env(),
    });

    expect(result).toEqual({ ok: true, delivered: 1 });
    expect(panel7.received).toHaveLength(1);
    expect(panel3.received).toHaveLength(0); // the §13 property: no cross-panel leak
    expect(panel7.received[0]?.envelope).toEqual(env());
  });

  it("stamps the attested source, ignoring a forged declared source", () => {
    const router = createRouter();
    const panel7 = sink(panel(7));
    const content7: Link = { attested: content(7), deliver: () => {} };
    router.addLink(panel7);
    router.addLink(content7);

    router.route(content7, {
      source: content(3), // lies about being tab 3
      target: panel(7),
      envelope: env(),
    });

    // Recipient sees the identity the transport vouched for, not the claim.
    expect(panel7.received[0]?.source).toEqual(content(7));
  });

  it("rejects a cross-tab target before any delivery", () => {
    const router = createRouter();
    const panel3 = sink(panel(3));
    const content7: Link = { attested: content(7), deliver: () => {} };
    router.addLink(panel3);
    router.addLink(content7);

    const result = router.route(content7, {
      source: content(7),
      target: panel(3), // another tab's panel
      envelope: env(),
    });

    expect(result).toEqual({ ok: false, reason: "unauthorized-target" });
    expect(panel3.received).toHaveLength(0);
  });

  it("reports no-route when the target is not connected", () => {
    const router = createRouter();
    const content7: Link = { attested: content(7), deliver: () => {} };
    router.addLink(content7);

    const result = router.route(content7, {
      source: content(7),
      target: panel(7), // never added
      envelope: env(),
    });

    expect(result).toEqual({ ok: false, reason: "no-route" });
  });

  it("round-trips a reply back to the original sender (reply-direction firewall)", () => {
    const router = createRouter();
    const content7 = sink(content(7));
    const panel7 = sink(panel(7));
    router.addLink(content7);
    router.addLink(panel7);

    // content@7 -> panel@7
    router.route(content7, {
      source: content(7),
      target: panel(7),
      envelope: env("pushTranscript"),
    });
    const request = panel7.received[0];
    expect(request?.source).toEqual(content(7));

    // panel@7 replies to whoever sent it — the attested source above.
    const reply = router.route(panel7, {
      source: panel(7),
      target: request!.source,
      envelope: env("pushTranscript:reply"),
    });

    expect(reply).toEqual({ ok: true, delivered: 1 });
    expect(content7.received[0]?.envelope.kind).toBe("pushTranscript:reply");
  });

  it("stops delivering after a link is removed", () => {
    const router = createRouter();
    const panel7 = sink(panel(7));
    const content7: Link = { attested: content(7), deliver: () => {} };
    const unlink = router.addLink(panel7);
    router.addLink(content7);

    unlink();

    const result = router.route(content7, {
      source: content(7),
      target: panel(7),
      envelope: env(),
    });
    expect(result).toEqual({ ok: false, reason: "no-route" });
    expect(panel7.received).toHaveLength(0);
  });
});

describe("isAddress", () => {
  it("accepts well-formed addresses and rejects malformed ones", () => {
    expect(isAddress({ context: "sw" })).toBe(true);
    expect(isAddress(content(7))).toBe(true);
    expect(isAddress(panel(0))).toBe(true);
    expect(isAddress({ context: "content" })).toBe(false); // missing tabId
    expect(isAddress({ context: "content", tabId: "7" })).toBe(false);
    expect(isAddress({ context: "nope", tabId: 7 })).toBe(false);
    expect(isAddress(null)).toBe(false);
    expect(isAddress("panel")).toBe(false);
  });
});
