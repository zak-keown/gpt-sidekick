// @vitest-environment jsdom
import { act } from "preact/test-utils";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rpc } from "@gpt-sidekick/core/protocol";
import { SERVICE_KINDS } from "@gpt-sidekick/core/service";
import type { OutlineItem } from "@gpt-sidekick/core/model";
import { OutlinePanel } from "./OutlinePanel";

vi.mock("./OutlinePanel.css", () => ({
  panel: "panel",
  header: "header",
  eyebrow: "eyebrow",
  heading: "heading",
  status: "status",
  state: "state",
  toolbar: "toolbar",
  reindex: "reindex",
  groups: "groups",
  group: "group",
  groupHeading: "groupHeading",
  list: "list",
  item: "item",
  itemButton: "itemButton",
  type: "type",
  title: "title",
  quote: "quote",
  copyButton: "copyButton",
  jumpState: "jumpState",
}));

const items: OutlineItem[] = [
  {
    id: "action-m1-0",
    type: "action",
    title: "Next step: ship the source jump.",
    summary: "Next step: ship the source jump.",
    evidence: [
      {
        messageId: "m1",
        quote: "Next step: ship the source jump.",
        offsetStart: 0,
        offsetEnd: 32,
      },
    ],
  },
  {
    id: "code-m2-0",
    type: "code",
    title: "const ready = true;",
    summary: "const ready = true;",
    evidence: [
      {
        messageId: "m2",
        quote: "const ready = true;",
        offsetStart: 0,
        offsetEnd: 19,
      },
    ],
  },
];

function fakeRpc(options: { earlyJumpResult?: boolean; items?: OutlineItem[] } = {}) {
  const handlers = new Map<string, (payload: unknown) => unknown | Promise<unknown>>();
  const requests: Array<{ kind: string; payload: unknown }> = [];
  const rpc: Rpc = {
    request: vi.fn(async (kind: string, payload: unknown) => {
      requests.push({ kind, payload });
      if (kind === SERVICE_KINDS.conversation) return "c1";
      if (kind === SERVICE_KINDS.outline) return options.items ?? items;
      if (kind === SERVICE_KINDS.indexState) {
        return {
          kind: "ready",
          messages: 12,
          items: 2,
          droppedNoEvidence: 1,
          unstable: 0,
        };
      }
      if (kind === SERVICE_KINDS.reindex) return { accepted: true };
      if (kind === SERVICE_KINDS.jump) {
        if (options.earlyJumpResult) {
          await handlers.get(SERVICE_KINDS.jumpResult)?.({
            requestId: "jump-1",
            status: "found",
          });
        }
        return { status: "relocating", requestId: "jump-1" };
      }
      throw new Error(`unexpected request: ${kind}`);
    }),
    handle: (kind, handler) => handlers.set(kind, handler),
    pendingCount: () => 0,
  };
  return {
    rpc,
    requests,
    async emit(kind: string, payload: unknown) {
      await handlers.get(kind)?.(payload);
    },
  };
}

const flush = () => act(async () => void (await Promise.resolve()));

describe("OutlinePanel — M3 user loop", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
  });

  it("groups outline items, previews evidence, and exposes trustworthy counts", async () => {
    const { rpc } = fakeRpc();
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    expect(root.querySelector('[data-testid="index-state"]')?.textContent).toContain(
      "Ready · 12 messages · 2 items · 1 dropped",
    );
    expect(
      [...root.querySelectorAll('[data-testid="outline-group"] h2')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["Actions 1", "Code 1"]);
    expect(root.textContent).toContain("Next step: ship the source jump.");
    expect(root.textContent).toContain("const ready = true;");
  });

  it("requests a bounded re-index and reflects pushed capture progress", async () => {
    const { rpc, requests, emit } = fakeRpc();
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    const button = root.querySelector<HTMLButtonElement>('[data-testid="reindex"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(requests).toContainEqual({ kind: SERVICE_KINDS.reindex, payload: {} });

    await act(async () =>
      emit(SERVICE_KINDS.indexStateChanged, {
        state: {
          kind: "capturing",
          processed: 4,
          captured: 3,
          expected: 10,
          unstable: 1,
        },
      }),
    );
    expect(root.querySelector('[data-testid="index-state"]')?.textContent).toContain(
      "Capturing · 4/10 turns · 1 unstable",
    );
    expect(button?.disabled).toBe(true);
  });

  it("requests source relocation and announces the asynchronous result", async () => {
    const { rpc, requests, emit } = fakeRpc();
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    const item = root.querySelector<HTMLButtonElement>('[data-testid="outline-item"]');
    await act(async () => item?.click());
    expect(requests).toContainEqual({
      kind: SERVICE_KINDS.jump,
      payload: { conversationId: "c1", messageId: "m1" },
    });
    expect(root.querySelector('[data-testid="jump-state"]')?.textContent).toContain(
      "Re-locating source",
    );

    await act(async () =>
      emit(SERVICE_KINDS.jumpResult, { requestId: "jump-1", status: "found" }),
    );
    expect(root.querySelector('[data-testid="jump-state"]')?.textContent).toContain(
      "Source highlighted",
    );
  });

  it("does not lose an immediate jump result that arrives before the request reply", async () => {
    const { rpc } = fakeRpc({ earlyJumpResult: true });
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    const item = root.querySelector<HTMLButtonElement>('[data-testid="outline-item"]');
    await act(async () => item?.click());
    await flush();

    expect(root.querySelector('[data-testid="jump-state"]')?.textContent).toContain(
      "Source highlighted",
    );
  });

  it("copies an item's grounded summary", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { rpc } = fakeRpc();
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    const copy = root.querySelector<HTMLButtonElement>('[aria-label="Copy action"]');
    await act(async () => copy?.click());
    await flush();

    expect(writeText).toHaveBeenCalledWith("Next step: ship the source jump.");
    expect(root.querySelector('[data-testid="jump-state"]')?.textContent).toContain("Copied");
  });

  // UAT 2026-08-11: every card printed its text twice — the extractor's title is
  // a prefix of the evidence quote by construction, so for the common short
  // quote the bold title and the grey preview were character-identical. The
  // preview must earn its line by showing what the title does not.
  it("prints a short item's text once, not twice", async () => {
    const { rpc } = fakeRpc();
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    const card = root.querySelector('[data-testid="outline-item"]');
    const text = card?.textContent ?? "";
    const occurrences = text.split("Next step: ship the source jump.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("previews the rest of a long quote instead of repeating its opening", async () => {
    const quote =
      "Let's use the enablement platform framing for the umbrella product name, " +
      "because it describes the architecture rather than any single feature.";
    const title = "Let's use the enablement platform framing for the";
    const { rpc } = fakeRpc({
      items: [
        {
          id: "decision-m9-0",
          type: "decision",
          title,
          summary: quote,
          evidence: [{ messageId: "m9", quote, offsetStart: 0, offsetEnd: quote.length }],
        },
      ],
    });
    await act(async () => render(<OutlinePanel rpc={rpc} />, root));
    await flush();

    const text = root.querySelector('[data-testid="outline-item"]')?.textContent ?? "";
    expect(text.split(title).length - 1).toBe(1); // the opening appears once
    expect(text).toContain("because it describes the architecture"); // the tail is still shown
  });
});
