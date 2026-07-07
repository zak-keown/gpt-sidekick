import { render } from "preact";
import { createChromeRpc } from "@gpt-sidekick/adapter-host-chrome";
import { SidePanel } from "@gpt-sidekick/ui";

const rpc = createChromeRpc();
render(<SidePanel rpc={rpc} />, document.getElementById("root")!);
