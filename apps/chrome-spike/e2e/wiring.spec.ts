import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const extensionPath = path.resolve(import.meta.dirname, "../.output/chrome-mv3");

// The side panel now reads the SW-owned store over the §13 routed RPC. There is
// no ChatGPT tab or content script here, so the panel has nothing to show — but
// reaching the "Connected" state PROVES the full routed round-trip booted: the
// panel connects (runtime.connect → SW onConnect past the sender/url gates),
// sends its hello, and its `fetchConversationId` request routes to the SW service
// and comes back (as null). A dead SW would hang → RPC timeout → "Error", never
// "Connected". This replaces the M0 echo round-trip as the SW-boot check.
test("side panel connects to the SW-owned store over the routed RPC", async () => {
  expect(
    fs.existsSync(path.join(extensionPath, "manifest.json")),
    "run `pnpm build` first — .output/chrome-mv3 missing",
  ).toBe(true);

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await expect(page.getByTestId("panel-status")).toContainText("Connected", {
      timeout: 10_000,
    });
  } finally {
    await context.close();
  }
});

test("capture → grouped outline → source highlight works through the built extension", async () => {
  expect(
    fs.existsSync(path.join(extensionPath, "manifest.json")),
    "run `pnpm build` first — .output/chrome-mv3 missing",
  ).toBe(true);

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const chatUrl = "https://chatgpt.com/c/gpt-sidekick-e2e";
    const sourceText = "Next step: ship the source jump.";

    const chat = await context.newPage();
    await chat.route("https://chatgpt.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <main>
            <article data-turn-id="turn-1">
              <div data-message-id="message-1" data-message-author-role="assistant">
                <div class="markdown">${sourceText}</div>
              </div>
            </article>
          </main>
        </body></html>`,
      }),
    );
    await chat.goto(chatUrl);
    await expect(chat.locator('[data-message-id="message-1"]')).toContainText(sourceText);

    // Direct panel-page navigation is the reliable headless fallback. Keep the
    // ChatGPT tab active while the background panel page boots so its
    // active/currentWindow lookup resolves the real content tab.
    const panel = await context.newPage();
    await chat.bringToFront();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await expect(panel.getByTestId("panel-outline")).toContainText(sourceText, {
      timeout: 10_000,
    });
    await expect(panel.getByTestId("outline-group").locator("h2")).toContainText("Actions");

    await panel.getByTestId("outline-item").click();
    await expect(panel.getByTestId("jump-state")).toContainText("Source highlighted", {
      timeout: 10_000,
    });
    await expect(
      chat.locator('[data-message-id="message-1"]'),
    ).toHaveAttribute("data-gpt-sidekick-highlighted", "true");
  } finally {
    await context.close();
  }
});
