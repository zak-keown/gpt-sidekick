import { render } from "preact";
import { connectRouted } from "@gpt-sidekick/adapter-host-chrome/routed-rpc";
import { OutlinePanel } from "@gpt-sidekick/ui";

/**
 * The panel needs its own tab id to route to the SW (a panel is a first-party
 * page with no Chrome-attested tab). For this spike it reads the active tab of
 * the current window — correct while the panel is open on the ChatGPT tab in a
 * single window; tab-switch / multi-window is the documented self-declared-tabId
 * limitation (SPEC §13, authoritative attestation deferred).
 */
async function main(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (typeof tabId !== "number") {
    render(
      <div data-testid="panel-status">Open the side panel on a browser tab.</div>,
      root,
    );
    return;
  }

  const rpc = connectRouted({ context: "panel", tabId });
  render(<OutlinePanel rpc={rpc} />, root);
}

void main();
