import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const extensionPath = path.resolve(import.meta.dirname, "../.output/chrome-mv3");

test("side panel echo round-trips through the SW router", async () => {
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

    await page.getByTestId("echo-input").fill("ping-42");
    await page.getByTestId("echo-send").click();

    await expect(page.getByTestId("echo-reply")).toHaveText("ping-42");
  } finally {
    await context.close();
  }
});
