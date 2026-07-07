# GPT-Sidekick — Architecture, Stack & Per-Surface Research

*Companion to [`gpt-sidekick-product-plan.md`](./gpt-sidekick-product-plan.md). This is the research-backed engineering plan: recommended architecture, a Python-free stack, per-surface capabilities/features, and foreseen pitfalls. Researched 2026-07-01 across five workstreams (providers, browser hosts, on-device ML, coding surfaces, stack).*

> **Volatility warning — read first.** Every provider DOM selector in this document is a **mid-2026 snapshot** and *will* rot. The durable output is the *capture strategy* (anchor tiers, observer patterns, graceful degradation), not the strings. Version-numbered platform facts (MV3 timings, WebGPU-by-platform, store rules) are the next most likely to drift. Confidence is marked **[H]/[M]/[L]** throughout; re-verify anything **[M]/[L]** at implementation time. This is engineering guidance, **not legal advice** — the ToS posture section flags where account risk is real.

---

## 0. TL;DR

- **Architecture:** one DOM-free TypeScript **core** behind an injected **Host port** (storage + messaging + compute-location), with thin **Provider adapters** (capture) and **Host adapters** (render + platform). The Host port is the linchpin that makes Chrome→Firefox→Safari→VS Code→JetBrains the *same* problem. The single hardest platform constraint — Chrome MV3's ephemeral service worker — dictates the whole runtime topology.
- **Stack (Python-free):** **WXT** (cross-browser MV3) · **pnpm + Turborepo** monorepo · **Preact + vanilla-extract** UI · **Dexie/IndexedDB** + brute-force cosine vectors · **Transformers.js v4** embedder in an **offscreen document** · **Vitest + Playwright** with dated DOM fixtures.
- **Surfaces ranked:** capture difficulty **ChatGPT < Claude < Gemini**; host fit **Chrome ≫ Firefox > Safari**; the coding-surface beachhead is **not** scraping IDE chat (provably impossible via public API) but **tailing on-disk agent JSONL transcripts** (Claude Code, Codex), which map 1:1 onto the core's event model.
- **Two forks to decide:** (1) embedding **delivery** — bundle vs first-run download vs remote-key; (2) on-device **extraction tier** — embeddings-only (T0) is *extractive* and can't reword/merge, so polished outline items need optional cloud key (T1) or a later WebGPU LLM (T2).
- **Forward-looking resolutions (§12):** no sanctioned *live* conversation API exists or is imminent → stay DOM-first, add a pluggable export/backfill adapter; the moat is **cross-provider + local-first**, not the outline itself; **offscreen-doc compute is permanent** and **WASM-first holds through ~2028**; **Safari is a NO-GO** (architectural, not just storage — it needs a native rewrite); **T2 stays opt-in** for 6–12 mo (good hardware only); self-correction needs a **pairwise NLI pipeline** (honest ceiling: catches logical contradictions, pivots ride on discourse markers); ship **bge-small**, benchmark a **static** embedder to enable bundling.

---

## 1. Recommended Architecture

### 1.1 The two axes: Provider × Host

The plan already names "adapters," but a flat adapter list hides where a problem actually lives. Every capability and pitfall is either **provider-level** (DOM churn, message identity, virtualization) or **host-level** (service-worker lifecycle, side-panel API, storage eviction, distribution). Model the product as a **matrix**, not a list:

```
                 HOST →   Chrome MV3   Firefox    Safari    VS Code    JetBrains
 PROVIDER ↓
 ChatGPT web              ██ launch    port       defer      —          —
 Claude web               phase 4      port       defer      —          —
 Gemini web               later        later      defer      —          —
 Coding agents (JSONL)     —            —          —        phase 6+    later
```

A single `core` sees only normalized `TranscriptEvent`s and never knows which cell produced them. **Provider adapters** answer "what was said and where is it"; **Host adapters** answer "where does my code run, where does UI render, where does data persist."

### 1.2 The Host port is the linchpin

Collapse everything platform-specific into one injected interface. This is the difference between five products and one:

```ts
interface Host {
  // Storage — always async; never lives in a sandboxed UI context.
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    // large/append data (transcripts, vectors) go to a Dexie-backed impl,
    // proxied over the message channel where the UI can't touch IndexedDB.
  };
  // Messaging LCD — one-way JSON send + subscribe; core layers correlation-ID RPC on top.
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
  // Compute location — "run this embedding job"; the host decides WHERE.
  runCompute(job: EmbedJob): Promise<EmbedResult>;
}
```

- **Chrome:** storage = `chrome.storage`/Dexie; compute = **offscreen document**; UI = side panel.
- **Firefox:** compute = **event page** (real DOM context, no offscreen needed); UI = `sidebar_action`.
- **VS Code:** storage = extension-host `Memento` proxied to the webview; compute = a Web Worker in the webview; UI = `WebviewView`.
- **JetBrains:** storage = `PersistentStateComponent`; compute = a **Node sidecar** the plugin spawns; UI = JCEF tool window.

`sidePanel` and `offscreen` are **Chrome-only** — they must never leak into `core` or the shared UI. [H]

### 1.3 Runtime topology is dictated by the MV3 service worker

The hardest fact in the whole product: **Chrome MV3 background service workers are killed after ~30 s idle and lose all in-memory state** [H]. You cannot run a multi-minute embedding/indexing pass there and trust it to finish. This is not a tuning problem; it is the shape of the runtime:

```
 [ content script ]  capture DOM, MutationObserver, source-jump
        │  (normalized TranscriptEvents, chunked)
        ▼
 [ service worker ]  THIN EVENT ROUTER ONLY — no heavy work, no durable state
        │  ▲
        ▼  │  (runtime messaging)
 [ offscreen doc ]   embedder (Transformers.js/ONNX) + Web Worker + vector math
        │            persists while open; unaffected by SW idle-kill
        ▼
 [ IndexedDB ]       transcript records + Float32Array vectors + outline
        ▲
        │  (Dexie liveQuery re-fires → auto re-render)
 [ side panel ]      shared Preact UI: outline, evidence, copy actions
```

**Rules that fall out of this** [H]:
1. SW is an event router; the embedder lives in the **offscreen document** (one per extension; lives until `closeDocument()`).
2. **Chunk indexing work and persist progress to IndexedDB after each chunk** so a mid-job SW termination is resumable — never hold indexing state in a global.
3. **`open()` on the side panel needs a user gesture** — you can't auto-pop it from a timer.
4. On **Firefox** the same discipline applies but the event page is itself a DOM context, so the embedder can run there directly (no offscreen). On **Safari**, there is no offscreen and background is fragile — capture must relay through background and compute is constrained.

### 1.4 Incremental pipeline (unchanged in spirit, sharpened)

The plan's rolling model is correct. Concretely: raw messages → stable transcript records (keyed by the most durable identity available, §3.2) → **structure-aware segments** (turn boundaries + cosine-drop between consecutive turn embeddings) → outline candidates (max-cosine classification against category anchors + cheap rules) → merged thread outline. New messages process **only the tail plus a small context window**; embeddings are cached per record so re-segmentation is cheap.

---

## 2. Recommended Stack (Python-free)

The whole toolchain is Node/CLI + (Safari-only) Xcode — **no Python anywhere**, which also matches the product's local-first thesis: the "no Python embedder" implication is satisfied by Transformers.js running the model in-browser.

| Layer | Recommendation (2026 version) | Alternative | Why not the alternative | Conf. |
|---|---|---|---|---|
| **Extension framework** | **WXT** `0.20.x` | CRXJS + Vite `2.7.x` | You hand-wire per-browser manifests + the Safari step | [H] |
| **Monorepo** | **pnpm workspaces + Turborepo** `2.x` | pnpm + Nx `23.x` | Nx's power is overhead below ~20 packages | [H] |
| **UI framework** | **Preact** `10.x` (+`preact/compat`) | Solid `1.9.x` | Smaller React-ecosystem reach; Solid 2.0 still beta | [H] |
| **Styling** | **vanilla-extract** (zero-runtime) | CSS Modules | Loses the typed cross-webview theme contract | [M] |
| **Local persistence** | **Dexie** `4.x` on IndexedDB | `idb` `8.x` | You rebuild migrations, `liveQuery`, reactivity by hand | [H] |
| **Vector search** | **brute-force cosine over flat `Float32Array` in a Worker** | pure-JS `hnsw` | ANN wins only above ~50–100k vectors | [H] |
| **On-device embedder** | **Transformers.js v4** (`@huggingface/transformers`) on ONNX Runtime Web | — | (see §8) | [H] |
| **Unit/integration tests** | **Vitest** `4.x` (core=node, adapters=jsdom) | happy-dom | jsdom completeness matters parsing real provider DOM | [H] |
| **E2E** | **Playwright** `1.x` (Chromium, `channel:'chromium'`) | Selenium/Puppeteer | No first-class MV3 SW access; flakier | [H] |
| **Firefox tooling** | **web-ext** `10.x` | — | — | [H] |
| **Rejected** | Plasmo (maintenance mode), React (~40 KB runtime for a panel) | — | — | [H] |

**Monorepo package boundaries** (native shells — Safari/Swift, JetBrains/Kotlin — stay *outside* the JS workspace):

```
packages/
  core/                      pure TS: transcript model, indexer, outline, source-linking, Host PORT
  adapters/provider-chatgpt  DOM allowed; depends on core
  adapters/provider-claude
  adapters/provider-gemini
  adapters/host-chrome        implements core's Host port (sidePanel + offscreen)
  adapters/host-firefox        (sidebar_action + event page)
  adapters/host-vscode         (WebviewView + Memento proxy)
  adapters/host-jetbrains      (JCEF + Node sidecar)
  ui/                        shared Preact components; imports core via `import type` only
apps/                        shippable bundles per host
```

**Keeping `core` DOM-free — enforced two ways, not by convention** [H]: (1) `core/tsconfig.json` sets `"lib": ["ES2023"]` (no `DOM`) + `"types": []`, so touching `document`/`window` fails to compile; (2) core tests run in Vitest `environment: 'node'`, so DOM globals are absent at runtime too; (3) ESLint `eslint-plugin-boundaries` forbids `core → adapters/hosts/ui` imports.

**Ship-small discipline is one coherent theme:** Preact (~5 KB) + Dexie + zero-runtime CSS + a self-hosted 384-dim model keep the panel light and the data on-device; vector *search* adds zero bundle (typed-array math).

---

## 3. The Capture Problem, Generalized

### 3.1 Durability ladder (applies to every DOM provider)

Anchor on the highest tier available; treat everything below the line as disposable:

```
  semantic HTML / ARIA roles                     ← most durable
  stable server-backed data-* (UUIDs)
  semantic data-testid / semantic class names
  ─────────────────────────────────────────────
  positional data-testid (conversation-turn-{N}) ← ordering only, NOT identity
  framework-hashed classes (_ngcontent, Tailwind soup)  ← disposable
```

### 3.2 The Evidence Invariant needs an identity strategy per provider

The plan's rule — *no evidence, no outline item*, every item's quote an exact substring of the cited message that resolves to a source anchor — is sound. But its weak point is **message identity**, and identity quality differs sharply by provider:

- **ChatGPT** hands you a real server UUID (`data-message-id`) in the DOM — the Evidence Invariant is cheap and rock-solid. [H]
- **Claude** and **Gemini** expose **no durable per-message id in the DOM**. Anchor on **content-hash + ordinal + turn-wrapper**, which *drifts on edit/regenerate*. Optional upgrade: **passively read the JSON the tab already fetched** (Claude `chat_conversations?tree=True` carries `uuid`; Gemini server `rcid`) to recover stable ids — higher fidelity but ToS-gray (§3.3). [H/M]
- Design **source-jump to degrade gracefully**: re-resolve nodes on Gemini (windowing detaches them), re-anchor by hash+ordinal on Claude edits, and show an honest "source moved / re-locating" state instead of a dead jump.

### 3.3 ToS posture (all three web providers)

Only the **official exports** are unambiguously sanctioned full-history paths, and they are **batch/latent, not live**. All three providers' terms **prohibit automated/scripted access outside their official APIs**, so scripting `/backend-api/*` (ChatGPT), `/api/…/chat_conversations` (Claude), or `batchexecute` (Gemini) is a Terms violation with real rate-limit/ban risk — **Anthropic actively enforced this in Jan 2026**. [H]

A content script reading the DOM of a page **the user is actively viewing in their own authenticated session** is a *materially lower-risk gray area* than headless/backend scraping — but it is not risk-free, and passive JSON interception (reading a response the tab itself requested) sits between the two. **Recommended posture:** live outline = DOM capture only; bulk history = the sanctioned export importer; treat passive-JSON identity upgrade as an explicit, off-by-default power-user setting with a clear risk disclosure. *(Not legal advice.)*

---

## 4. Provider Surfaces

Filling in the plan's `ProviderCapabilities` type with researched values. `fullServerHistory` is refined: for all three it is **export-only** (sanctioned, batch, point-in-time) — never a live signal.

| Capability | **ChatGPT** | **Claude** | **Gemini** |
|---|---|---|---|
| `liveCapture` | ✅ | ✅ | ✅ (must re-resolve nodes) |
| `readLoadedHistory` | ✅ strong | ✅ full | ⚠️ rendered-only |
| `bestEffortBackfill` | ~N/A (all loaded) | ~N/A (all loaded) | ⚠️ **required & lossy** (force-scroll) |
| `fullServerHistory` | export `conversations.json` | export JSON | Takeout → **My Activity → Gemini Apps** |
| `stableMessageIds` | **yes** (`data-message-id` UUID) | **partial** (DOM no / JSON `uuid` yes) | **partial** (conv id yes / msg no) |
| `sourceJump` | ✅ strong | ⚠️ medium (hash+ordinal) | ⚠️ weakest (windowing + weak id) |
| Framework (2026) | React / Remix | React (Remix?) | **Angular + Material** *(live-verified)* |
| Virtualization | none | none (crashes ~1000+ msgs) | **windowed** (`infinite-scroller` ×2 live) |

> **Provenance caveat:** only **Gemini** was inspected in a live browser (2026-07-01); ChatGPT and Claude were blocked by Cloudflare / login in the automation session, so their rows are from **official docs + community/reverse-engineered exporters** (convergent across ~25 repos), not first-hand inspection. Trust the Gemini structural facts most; verify ChatGPT/Claude selectors against a live authenticated session before relying on them.

### 4.1 ChatGPT web — *easiest*
- **Anchors [as of 2026-07, expect churn]:** `[data-message-id="<uuid>"]` (server UUID, mirrors the export `mapping` id) + `data-message-author-role`; turn boundary `<article>`; `data-testid="conversation-turn-{N}"` for **ordering only**. Avoid `.markdown/.prose` and Tailwind hashes.
- **Streaming/completion:** SSE `POST /backend-api/conversation`; robust "done" = send↔**stop button** toggle. **One visual turn can contain multiple message nodes** (tool → reasoning → answer) — key on the UUID, never turn index. [M-H]
- **Rich content:** code `<pre><code class="language-…">`; native `<table>`; images via `/backend-api/files/download/:id`; **Canvas renders in a separate side-panel editor (ProseMirror/CodeMirror), NOT inline** — capture the canvas pane separately.
- **Biggest pitfall:** anchoring on the positional `conversation-turn-{N}` or hashed classes; and missing that a turn hides multiple messages.

### 4.2 Claude web — *medium*
- **Anchors:** `.font-claude-message` / `.font-user-message`; `[data-is-streaming]`; author discriminator = the assistant-only `[aria-label="Give positive feedback"]` button. **`data-test-render-count` is a render counter, not identity.** [H]
- **Streaming/completion:** wrapper `data-is-streaming="true"` → false + `[role=group][aria-label="Message actions"]` toolbar appears. Agentic runs add `#claude-agent-stop-container`.
- **Rich content:** code `<pre>`; **Artifacts in a dedicated right-side panel, not inline** (inline = clickable card; `#markdown-artifact`). Extract artifact source from the open panel or server JSON. Export JSON's inclusion of artifact bodies/attachments is **unstated — verify against a real export.** [M]
- **Biggest pitfall:** no stable DOM message id → source-jump keyed on position drifts on edit/regenerate; recover identity via passive server-JSON `uuid` if needed.

### 4.3 Gemini web — *hardest* *(live-verified 2026-07-01)*
- **Anchors:** Angular **custom-element tag names** — `<user-query>`, `<model-response>`, `<code-block>`, `chat-window`, `infinite-scroller` — plus `aria-live`. Everything `_ngcontent-ng-cXXXX` / `mat-*` is build-hashed = disposable. LaTeX lives in a durable `data-math` attribute.
- **Streaming/completion:** the `<model-response>` subtree is **node-replaced during streaming** — do **not** hold node refs; bind the observer to a stable ancestor and **re-resolve `<model-response>` each mutation batch**; detect done via ~300–500 ms mutation quiescence + action-bar appearance. [M]
- **History:** **windowed** — two `infinite-scroller`s live; off-screen turns detach. **Backfill is genuinely best-effort and lossy** (force-scroll, capture before detach). [H for windowing]
- **Export trap:** transcripts are under **Takeout → My Activity → "Gemini Apps"**, JSON/HTML — the standalone "Gemini" product line-item is Gems/saved-info, *not* transcripts. Gated by Gemini Apps Activity being ON; excludes side-panel Gemini-in-Gmail/Docs.
- **Biggest pitfall:** virtualization + node re-rendering during streaming (both defeat "hold a node / full DOM" assumptions), plus the Takeout line-item trap.

**Highest-value items to re-verify against a live authenticated session:** (1) ChatGPT stop/action-button `data-testid` strings + any new lazy hydration on very long chats; (2) Claude export completeness for artifact bodies/attachments; (3) Gemini's live message-level custom-element tags + whether any durable per-message DOM id now exists.

---

## 5. Host Surfaces

| Capability | **Chrome (MV3)** | **Firefox** | **Safari** |
|---|---|---|---|
| **Side-panel UI** | ✅ `sidePanel` (114+); gesture-to-open | ⚠️ `sidebar_action` (persistent; needs adapter) | ❌ none → inject in-page UI or toolbar popover |
| **Persistent capture** | ⚠️ SW ephemeral (30 s) → offscreen + chunk + persist | ⚠️ event page (DOM; no offscreen needed) but still idle-suspends | ⚠️ background fragile; iOS non-persistent; relay via background |
| **WASM embedder** | ✅ `'wasm-unsafe-eval'`; **bundle .wasm locally**; run in offscreen | ✅ runs in event page directly | ✅ supported; App Store code rules apply |
| **WebGPU accel** | ✅ documents (offscreen/panel) | ⚠️ **partial** — Win (FF141), macOS-AS (FF145); else → WASM | ⚠️ shipped (Safari 26) but **extension-context exposure unverified** |
| **Storage headroom** | ⚠️ 10 MB default → **`unlimitedStorage`** lifts local+IDB+Cache | ✅ larger default; `unlimitedStorage` + `persist()` | ⚠️ disk-share cap **+ 7-day ITP eviction risk** |
| **Distribution** | 🟨 CWS review (broad host perms scrutinized) | 🟨 AMO mandatory signing + review | 🟥 App Store + native wrapper + paid account |

**Biggest trap per host:**
- **Chrome** — treating the **service worker as a durable worker** (it dies at ~30 s idle, loses all state). Secondary trap: pointing ORT's WASM at a **CDN** passes dev but **fails Web Store remote-code review** — bundle it locally via `chrome.runtime.getURL`. [H]
- **Firefox** — API divergence, not capability: no `sidePanel` (use `sidebar_action`) and **WebGPU is platform-gated**, so the GPU path silently degrades to WASM on Linux/older Macs. Keep a WASM fallback and don't assume acceleration. [M]
- **Safari** — **WebKit ITP evicts script-created storage after ~7 days of no interaction**; whether extension-origin `storage.local`/IndexedDB is exempt is **undocumented and must be tested** — if not, the entire "persistent on-device index" value prop evaporates after a week of non-use. [L — verify] *But the forward-looking pass (§12.4) shows the **deeper** blocker is architectural — Safari has no side-panel primitive and no offscreen/persistent-background at all — which makes it a native rewrite regardless of how the storage question resolves.*

### 5.1 The central permissions/UX tension (and its mitigation)
Passive DOM capture across chat sites **requires broad `host_permissions`** — `activeTab` can't do it (gesture-scoped, ephemeral). So the core function forces the scary *"read and change your data on [sites]"* install prompt **and** draws the heaviest store review. **Mitigation [H]:** ship with minimal host permissions, declare the chat domains under **`optional_host_permissions`**, and request each via `chrome.permissions.request()` behind a user gesture (an in-panel *"enable on this site"* toggle). One giant install prompt becomes small, per-site, user-driven grants — better trust story, lighter review posture. This *is* the plan's "per-site permissions" privacy feature, made concrete.

### 5.2 Host sequencing
**Chrome-first** (offscreen embedder, `unlimitedStorage`, per-site opt-in, bundled WASM). **Firefox = cheap port** (sidebar adapter + WebGPU/WASM fallback + `persist()`). **Safari = NOT a port at all** — the forward-looking research (§12.4) reframes it: Safari has no side-panel primitive and no offscreen/persistent-background context (no roadmap), so the persistent-panel + sustained-compute core can only exist there as a **native companion app — a separate product, not a port.** Defer indefinitely behind the §12.4 tripwires; the storage-eviction risk is real but secondary to this architectural wall.

---

## 6. Coding Surfaces — the on-disk reframe

The plan lists coding tools as a second surface "with different capture." Research sharpens this into a **strategic reframe**: the strongest capture path is **not** reading another assistant's chat (provably impossible via public API) but **tailing the append-only JSONL transcripts coding agents already write to disk** — verified by primary on-disk inspection on this machine.

### 6.1 The load-bearing negative result
**VS Code's public API cannot read Copilot's (or any other extension's) chat.** [H] The Chat Participant API only receives prompts a user routes to *its own* `@mention` (`context.history` is scoped); the Language Model API is **send-only**. So to have conversation data *in* VS Code, the user must be talking to **us** (our participant/webview), not to Copilot. Reading a competitor's chat is only ever a fragile disk-read backdoor, never a supported API.

### 6.2 The beachhead: on-disk JSONL + hooks
| Tool | Location | Format | Tail-friendly | Confidence |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<slug>/<uuid>.jsonl` | append-only typed JSONL (user/assistant/thinking/tool; `cwd`,`gitBranch`,`parentUuid`) | ✅ | [H] loc / [M] schema |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | append JSONL `{type,timestamp,payload}` (Responses-shaped) | ✅ | [H] / [M] |
| **Aider** | project `.aider.chat.history.md` | markdown append | ✅ (heuristic parse) | [H] / [L-M] |
| **Continue.dev** | `~/.continue/dev_data/*.jsonl` | **documented, schema-versioned** append JSONL | ✅ | [H] |
| Cursor / Cline / Roo | SQLite `state.vscdb` / blob-rewrite JSON | rewrite-in-place | ❌ poll+diff | [L-M] **high churn** |

These append-only JSONL streams **decompose 1:1 into the core's normalized events** — no reverse-engineering guesswork for the two flagship agents. A single Node reader (`fs.watch` on the directory + byte-offset incremental read, tolerate a trailing partial line) captures Claude Code and Codex whether the user is in a terminal, VS Code, or JetBrains — **no plugin-store review, and `core` runs as plain Node with zero port cost**, proving the shared-core thesis cheaply. Upgrade path for lower latency: a **Claude Code async HTTP hook** (`type:"http"`, `async:true`) POSTs each event to the localhost core with zero agent-latency penalty. **Pitfall:** these JSONL schemas are vendor-internal and officially "not stable" — version-pin and parse defensively.

### 6.3 IDE surfaces as UI-delivery (not capture)
- **VS Code:** `WebviewViewProvider` renders the shared Preact UI unchanged (sandboxed iframe, no `vscode` API inside — capture/privileged work stays in the extension host, brokered over `postMessage`). Genuine capture *signals* available: **terminal** via the stable `onDidStart/EndTerminalShellExecution` + `TerminalShellExecution.read()` (v1.93; needs shell integration; command-scoped, not raw PTY — the raw `onDidWriteTerminalData` is permanently proposed, don't ship it), and **file/diff/git** via `onDidChangeTextDocument` + the semi-official Git extension API.
- **JetBrains:** JCEF embeds the same web UI in a tool window (Kotlin, `JBCefBrowser`, `JBCefJSQuery` bridge), but JCEF is browser V8 with **no Node** — capture needs a **spawned Node sidecar** (JVM orchestrates, JCEF renders). This is the one surface with real port cost; ship it **last**.

### 6.4 Coding-surface sequencing
(1) Node on-disk/hook capture for Claude Code + Codex → prove the core. (2) VS Code as a **UI-delivery** surface + terminal/git *signals* + our own chat participant if we want in-IDE conversation capture. (3) Continue `dev_data` + Aider as easy add-ons. (4) Cursor/Cline/Roo only when justified (fragile SQLite/blob). (5) JetBrains last.

---

## 7. On-Device ML Layer

**Consensus across the ML and stack workstreams** [H]: **Transformers.js v4** (`@huggingface/transformers`) on ONNX Runtime Web, **WASM-SIMD single-thread by default**, **WebGPU opt-in** (probe `navigator.gpu`; **explicit fallback, no silent downgrade**), running **inside the offscreen document** (never the service worker — ORT breaks there and the SW dies at 30 s). Multi-thread WASM needs cross-origin isolation (SharedArrayBuffer) that's awkward in extensions, so single-thread SIMD is the pragmatic default. A 500-turn transcript embeds in **well under a few seconds** on WASM.

**Embedding model** (all 384-dim, int8):

| Model | int8 size | Role |
|---|---|---|
| **bge-small-en-v1.5** | **~34 MB** | **default** — best short-text quality in class |
| all-MiniLM-L6-v2 | ~23 MB | smaller fallback (~6 MTEB pts lower) |
| EmbeddingGemma-300M | (WebGPU, 768→MRL) | opt-in multilingual/quality upgrade (**Gemma license, not Apache** — review) |

**Delivery:** **download-on-first-run** (weights are *data*, fetch + cache in the Cache API; ~34 MB one-time for the bge-small default — 23 MB for the MiniLM fallback — with a progress affordance) — but the **ORT WASM binaries are *code* and MUST be bundled locally** (MV3 remote-code rule) and the model host allow-listed in `connect-src`/`host_permissions`. int8 is the right default; quantization barely dents cosine-similarity quality.

**Extraction tiers — an honest ceiling** [H]: embeddings do **segmentation** and **classification into the 6 categories** well (hybridized with cheap rules: fenced blocks→code, `?`→question, "let's/TODO"→action, "we'll go with/decided"→decision, "actually/I meant"→correction). But **embeddings are *extractive only*** — they can *select/rank* a representative existing sentence, not *reword*, resolve coreference, or *merge* a multi-turn decision into one crisp line.

| Tier | What | v1? |
|---|---|---|
| **T0** rules + embeddings | segment + classify + pick best representative snippet | **default** |
| **T1** optional user API key | send selected snippets to the user's own model for clean abstractive items | **optional, opt-in** |
| **T2** on-device WebGPU LLM | WebLLM/Transformers.js (Qwen2.5-0.5/1.5B); 0.5–2 GB download, WebGPU-only | **later opt-in** |

**Plan T0's output as "best representative snippet per item," not "polished summary."** Polished, reworded outline items require T1 or T2. Recommend **v1 = T0 default + T1 optional (bring-your-own-key)**; T2 as a later power-user path on capable hardware. *(Note: "correction" is the hardest category for embeddings-only — corrections embed near the content they correct — so lean on rules there and expect lower recall until T1/T2.)*

---

## 8. Features Supportable Per Surface

Consolidated view. ✅ full · ⚠️ partial/conditional · ❌ not supported · — n/a.

| Feature | ChatGPT | Claude | Gemini | VS Code | JetBrains |
|---|---|---|---|---|---|
| Live incremental outline | ✅ | ✅ | ✅ | ✅ (our chat / on-disk) | ✅ (sidecar) |
| Source-jump to exact message | ✅ | ⚠️ hash+ordinal | ⚠️ windowed | ✅ (transcript line) | ✅ |
| Backfill already-loaded history | ✅ | ✅ | ⚠️ lossy | ✅ (whole file) | ✅ |
| Bulk import (sanctioned export) | ✅ conversations.json | ✅ JSON | ✅ Takeout | ✅ JSONL | ✅ JSONL |
| Code-block extraction | ✅ | ✅ | ✅ | ✅ | ✅ |
| Canvas/artifact capture | ⚠️ separate panel | ⚠️ separate panel | ⚠️ separate panel | ✅ file/diff | ✅ file/diff |
| Decision/Action/Question/Correction | ✅ | ✅ | ✅ | ✅ | ✅ |
| Diff/commit as artifact | — | — | — | ✅ (git API) | ✅ (git4idea) |
| Terminal-command capture | — | — | — | ✅ shell-exec API | ⚠️ weaker |
| Read a *competitor's* assistant chat | — | — | — | ❌ (API-blocked) | ❌ |
| Stable durable IDs w/o JSON | ✅ | ❌ | ❌ | ✅ | ✅ |

Host-level feature availability (independent of provider):

| Feature | Chrome | Firefox | Safari |
|---|---|---|---|
| Side-panel outline UI | ✅ | ⚠️ sidebar | ❌ inject/popover |
| On-device embedder | ✅ offscreen | ✅ event page | ⚠️ constrained |
| WebGPU acceleration | ✅ | ⚠️ platform-gated | ⚠️ unverified |
| Large persistent index | ✅ unlimitedStorage | ✅ +persist() | ⚠️ ITP-eviction risk |
| Per-site opt-in permissions | ✅ | ✅ | ⚠️ |
| One-click store install | ✅ | ✅ | ❌ App Store + wrapper |

---

## 9. Foreseen Pitfalls, Consolidated

**Cross-cutting**
- **MV3 SW is not a worker** — chunk + persist or lose the index mid-job. [H]
- **Provider DOM churn** — anchor by durability tier, snapshot dated fixtures, run a weekly non-blocking CI re-capture-and-diff to catch drift *before users do*. [H]
- **ToS/account risk** — live = DOM-only; never script backend endpoints by default; passive-JSON is opt-in with disclosure. [H]
- **Remote-code review failure** — bundle ORT WASM locally; only model *weights* may be fetched. [H]
- **Embeddings are extractive** — don't promise reworded summaries at T0. [H]

**Provider** — ChatGPT: positional-turn / multi-node-turn trap. · Claude: no DOM UUID (drift on edit). · Gemini: node re-render during streaming + lossy windowed backfill + Takeout line-item trap.

**Host** — Chrome: SW lifetime + CDN-WASM review. · Firefox: `sidebar_action` divergence + platform-gated WebGPU. · Safari: 7-day ITP eviction (verify!) + no side panel + App Store gate.

**Coding** — vendor JSONL schemas are unstable (version-pin); SQLite/blob tools (Cursor/Cline) churn hard; no API reads a competitor's chat.

---

## 10. Open Decisions (now resolved — see §12 for the forward-looking research behind each)

The second research pass turned these forks into recommendations. Verdicts below; rationale, trajectory, and triggers in §12.

1. **Embedding delivery** → **fetch-on-first-run `bge-small` int8 (~34 MB) local default** + remote-with-key as explicit opt-in (never silent). *Forward-looking:* nothing browser-runnable in the ~30 MB neural class beats bge-small; the only path to *bundling* is a **static embedder (potion-base-8M, ~7.6 MB)** — benchmark it on your real cosine task (not MTEB Classification) and adopt if it holds. **→ §12.7**
2. **Extraction tier for v1** → **T0 default + T1 (BYO key) opt-in; T2 opt-in, not default.** *Forward-looking:* T2 is a *second runtime* (WebLLM + XGrammar constrained decoding — Transformers.js can't constrain-decode); reconsider as default in 6–12 mo for good hardware only. **→ §12.5**
3. **Passive-JSON identity upgrade** for Claude/Gemini → **off by default, disclosed power-user setting.** *Forward-looking:* no sanctioned live API replaces it; risk gradient is **Claude-highest**; the sanctioned play is a **backfill/export adapter**, not live JSON scraping. **→ §12.1**
4. **Safari go/no-go** → **NO-GO / defer indefinitely.** *Forward-looking (reframed):* the blocker is **architectural** — no side-panel primitive and no offscreen/persistent-background context, no roadmap — so Safari is a **native-companion rewrite (a separate product)**, not a port. Watch the four tripwires in §12.4. **→ §12.4**
5. **Storage durability** → declare `unlimitedStorage` **and** call `navigator.storage.persist()`. **Correction:** `persist()` rescues **Firefox** (durable by design) but **not Safari** (it exempts only installed Home-Screen/Dock web apps, not extension origins). On Chrome, `unlimitedStorage` already covers both quota and eviction. **→ §12.4**

---

## 11. Revised Sequencing (research-informed)

Consistent with the plan's Product Sequence, with the surfaces now concrete:

1. **Spike** — Chrome + ChatGPT + local storage + outline from loaded DOM (ChatGPT's server UUID makes this the highest-confidence starting cell).
2. **Alpha** — live capture, source-jump, copyable decisions/checklists/code, per-site `optional_host_permissions` opt-in, offscreen-doc embedder (T0), conversations.json importer.
3. **Harden** — dated parser fixtures + weekly drift CI, Playwright e2e (source-jump on a real page), privacy review, `persist()`.
4. **Second provider — Claude** (proves the adapter boundary; forces the no-DOM-UUID identity strategy).
5. **Second host — Firefox** (proves host portability via WXT; cheap).
6. **Coding surface — on-disk JSONL beachhead** (Claude Code + Codex tail/hooks; proves the shared core as plain Node) → then VS Code webview for UI.
7. **Gemini**, then **T1 (BYO key)**, then optional **Safari** / **JetBrains** / **T2** — each gated on the decisions in §10.

---

## 12. Forward-Looking Resolutions to Open Questions

*A second research pass (July 2026) that resolves §10's open decisions and the scattered "verify" items, each with a v1 decision, a trajectory ("when the better option arrives"), and a monitoring trigger. Same confidence discipline; the honest ceilings are stated, not buried.*

### 12.1 Conversation access — no sanctioned live API is coming; split "live" from "backfill"

**Resolution.** Separate the two jobs and treat them differently:
- **Live outline (the chat you're in now):** DOM reading is the *only* real-time option — **zero** sanctioned mechanism (shipped or roadmap) touches the live in-session transcript, and this is structural, not a gap about to close. **Stay DOM-first.**
- **Bulk backfill (your archive):** sanctioned **manual exports already exist** (ChatGPT `conversations.json`, Claude export, Gemini Takeout). **Build a pluggable "sanctioned-source adapter" now** and wire these in — justified by *present value + cheap optionality*, not a predicted API date. A future portability API drops into the same slot.

**DOM-first ≠ DOM-safe.** All three ToS prohibit automated access; the risk is *latent, not realized* for read-only outlining. The Jan 2026 Anthropic enforcement was **adjacent precedent** (it targeted inbound compute-arbitrage / OAuth-token spoofing of the Claude Code harness, not history reading) — so it doesn't establish that read-scraping gets blocked, but it shows willingness to act. **Per-provider risk gradient:** **Claude highest** (demonstrated enforcement + explicit "third parties may not offer claude.ai access" language) · **ChatGPT / Gemini lower** for read-only DOM.

| Sanctioned path | Status | Use for GPT-Sidekick |
|---|---|---|
| Per-provider **manual exports** | **shipped** | **Use now** — the backfill backbone; individual-scoped, manual/emailed (Gemini Takeout schedulable → Drive every 2 mo) |
| **Google Data Portability API** | shipped, **no Gemini scope** | **Dead end** (verified: scopes cover maps/play/search/etc., not gemini/bard; EEA/UK/CH only) |
| **DTI conversation-history data model** | emerging, not adopted | Candidate **canonical schema** for the adapter; monitor for multi-provider adoption |
| Enterprise Compliance APIs (OpenAI/Anthropic) | shipped, programmatic | **Structurally irrelevant** — org-admin/compliance scope, reads *other* users' chats, Enterprise-gated |
| Connectors / Apps SDK / MCP / Responses API | shipped | **Inbound** (feed data *into* the assistant); not transcript export |

**Regulation underwrites bulk export, not a live API.** GDPR Art 20 = machine-readable *bulk export* (already provided); EU Data Act (applicable 12 Sep 2025) = IoT + cloud-switching, doesn't cleanly reach chat data; the **only** binding "real-time access" mandate is DMA Art 6(9)/(10) — but only for *designated gatekeepers*, and **no gen-AI chatbot is designated** as of mid-2026. Don't build a thesis on "regulation will force a live API."

**Monitoring triggers → shift toward adapter-primary if:** (1) any provider ships an *individual/authorized-app* history API; (2) DMA designates a chatbot as a "virtual assistant" gatekeeper (real-time portability could then be mandated); (3) the DTI data model reaches multi-provider adoption.

### 12.2 Defensibility — the outline is the hook; the moat is *cross-provider + local-first*

**Resolution.** Be honest that a source-linked outline is the **entry hook, not the moat** — it's commoditized by third-party extensions today and a provider could ship a native single-thread table-of-contents in a quarter. Defensibility comes from the two axes a single provider **structurally cannot occupy**:
1. **Cross-provider unified view** — no provider will map across your ChatGPT + Claude + Gemini history (no access to rivals, every incentive against neutrality). Gemini's "import memory from other AIs" *proves the direction*: providers consolidate by pulling you **into** their walls, never by mapping neutrally across all.
2. **Local-first / privacy** — a provider's "outline" lives on their servers by construction; they're disincentivized at the business-model level from keeping the map off their servers.

Natives already ship (and thus commoditize) **single-provider** organization (ChatGPT/Claude Projects, Gemini Gems), memory, and history search; OpenAI's June 2026 "Sources" chip even softens the "source-linked" framing. But the whitespace is real and **unoccupied**: no provider ships an in-thread outline/jump-to-source, and the best third-party competitors are per-conversation, omit Claude, and/or sync to a server. **A unified, Claude-inclusive, strictly-local map is open ground — and the deeper each walled garden's memory grows, the more valuable a neutral, private layer that spans and outlives all of them.** *Product line: lead with the outline; defend on cross-provider + local-first.*

### 12.3 Platform trajectory — offscreen-doc is permanent; WASM-first through ~2028

**Resolution (MV3 SW):** **Build hard around the offscreen document — it is future-proof for Chrome.** The ephemeral event-driven service worker (30 s idle, 5-min task cap) is a **settled model, not a transitional one**: the last lifetime-extending change was Chrome 120 (Dec 2023), there's no blink-dev intent toward persistence, and the cross-vendor position (WECG #518, open-but-unmoved since Feb 2025) is "program defensively." Offscreen docs opened for `WORKERS`/`DOM_SCRAPING` carry **no lifetime limit** (only `AUDIO_PLAYBACK` auto-closes) → they persist immune to the SW timers. Constraints to design around (not blockers): one offscreen doc per profile (multiplex); the SW must be alive to (re)create it → the **chunk-and-persist-to-IndexedDB rule stays mandatory** for resumability. (WebGPU-in-SW landed in Chrome 124, but the SW still dies at 30 s and ORT-Web's WASM path is unreliable there — the embed pass still belongs in offscreen.)

**Resolution (WebGPU):** **Keep WASM-SIMD first; a CPU fallback is mandatory through ~2028.** Runtime-probe `navigator.gpu` + `requestAdapter()` and fall back explicitly — never gate on browser/version. "API present in the latest of every engine" is ~now; "safe to default *without* a fallback across the deployed base" is ~2028, paced by installed-base upgrade. Long poles: **Safari** (`navigator.gpu` needs macOS Tahoe 26 / iOS 26 — strands older-OS installs into 2027–2028; Intel Macs largely excluded) · **Firefox** (Windows since 141, macOS Apple-Silicon since 145; **Linux still Nightly, Android flagged, Intel-Mac no timeline; no WebGPU in Service Workers**) · **Chrome-Linux** X11 / non-allowlisted-GPU holes. WebGPU stays an **opt-in accelerator**, not the baseline.

### 12.4 Safari — reframed to NO-GO / defer indefinitely (the blocker is *architectural*, not storage)

**Resolution.** This reverses the §5/§10 framing in an important way: **storage eviction is a real risk but not the decisive blocker — architecture is.** Safari has **no side-panel primitive at all** (`sidebarAction` and `sidePanel` both absent on Safari + iOS; only a focus-loss-dismissed toolbar popover) and **no offscreen / no reliable persistent-background context** — with **no roadmap** for either. The product's persistent-side-panel + offscreen-sustained-compute core **cannot be built in-browser on Safari.** Its only path to sustained on-device compute is a **native companion app** (native ONNX via `sendNativeMessage`) — a *different product architecture*, not a port.

The storage question, secondarily, points the same way and is **officially unknown**: whether 7-day ITP eviction spares a `safari-web-extension://`-origin `storage.local`/IndexedDB is undocumented — and **IndexedDB in the extension origin is exactly where GPT-Sidekick's vector index would live** (highest-risk regime). **Correction to §10.5:** `navigator.storage.persist()` rescues **Firefox** (durable by design) but **not Safari** — it only exempts installed Home-Screen/Dock web apps, not extension origins, and can report "granted" while data is still deleted at 7 days.

**Verdict:** Safari is **not a "cheap port" like Firefox** — it's a native rewrite scoped as its own product, or nothing. Defer indefinitely; **revisit only when a tripwire fires:** (1) MDN BCD `sidebarAction.safari` flips `false` → a version; (2) a WECG side-panel/offscreen issue shows Apple adoption intent; (3) Apple documents extension-origin storage persistence; (4) `navigator.gpu` is confirmed in a Safari extension background/popover context.

### 12.5 On-device generative extraction (T2) — opt-in now; not a default for 6–12 months, and only ever on good hardware

**Resolution.** Keep T2 an **explicit opt-in**, built on **WebLLM + XGrammar** (JSON-schema/grammar-constrained decoding, compiled to WASM, fully client-side). Key architectural fact: **Transformers.js has no constrained decoding** (issue #1328, open since May 2025, no roadmap), so **T2 is a *second runtime*** (WebLLM/WebGPU) bolted alongside the Transformers.js embedding tier — not a model dropped into the existing pipeline. Because the user has already accepted this tier's cost, default to the **hardware ceiling**: **Qwen3.5-4B on capable machines (16 GB+/Apple-Silicon/discrete GPU) → Qwen3.5-2B → 1B**, gated on a **runtime WebGPU + memory probe** (presence alone is insufficient); use a WASM LLM (wllama) for the no-WebGPU tail (notably Firefox desktop), treating its grammar enforcement as unverified.

**Why not default:** the blocker isn't "does it run" — it's **reliable typed output on typical memory**. Unconstrained JSON is only reliable at ~3–4B; grammar-constraint rescues ~2B *syntactically* but the models light enough to run everywhere (~1 B) aren't reliable, and the reliably-typed 2–4B tier excludes low-end hardware and Firefox-desktop. **Quality ceiling:** even constrained, a 2–4B model's *semantic* extraction (merging multi-turn items, coreference, faithful rewording) is materially below a frontier cloud model — so **T1 (user API key) remains the high-fidelity path.**

**When it flips:** reconsider T2-as-default in ~6–12 months **for mid-range-and-up hardware only** — Transformers.js v4's 3–10× WebGPU speedup + a stronger constrained ~2B make it *credible*, but not universal while the low-end + Firefox tail exists.

### 12.6 Self-correction detection — a pairwise pipeline, and honest about what it can't catch

**Resolution.** Don't use a single classifier; **corrections embed *near* what they correct**, which is exactly why the embeddings-only approach was weak. Use a three-stage pairwise pipeline, all shippable on-device today:
1. **Candidate pairs for free** — reuse the bge-small vectors T0 already computes; for each later assistant sentence, take the top-k earlier same-topic sentences by cosine (kills the O(n²), no extra download).
2. **Cheap priors that carry real weight** — self-correction discourse markers ("actually", "wait", "correction", "I was wrong", "to clarify", "let me revise") + temporal order (later overrides earlier).
3. **Directional NLI cross-encoder judge on the shortlist only** — premise = earlier, hypothesis = later; flag the `contradiction` label as a reversal. Ship **nli-roberta-base (~120 MB) or ModernBERT-base-nli (~151 MB)** (clean BPE tokenizers, onnx-community builds), downloaded on first use. **Avoid DeBERTa-v3 NLI** despite its smaller size — its SentencePiece→fast conversion drops byte-fallback and can mis-tokenize the code/math/URLs/emoji common in chat transcripts.

**Honest ceiling (a category caveat, not a footnote):** NLI's `contradiction` fires only on *logical* contradiction ("earlier X, actually not-X") at ~high-70s–mid-80s accuracy. But "self-correction" is **broader** — pivots and augmentations ("we should *also* consider Z") and non-reversing refinements are `neutral` to NLI and **will be missed by the judge**, so their recall rides almost entirely on the **discourse-marker + temporal priors** (the markers are *load-bearing*, not decoration). **Surface all reversals/pivots as review candidates, not verified facts.** **When it improves:** a fine-tune on dialogue data (DECODE / DialogueNLI, both on HF) lifts the ceiling to ~85–93%; once T2 ships, the LLM can serve as a higher-ceiling judge that *also* catches the non-contradictory pivots NLI misses.

### 12.7 Embedding delivery — the bundle-vs-download tension eases via *static* embeddings, not smaller neural models

**Resolution.** **Nothing browser-runnable in the ~30 MB neural class beats `bge-small-en-v1.5`** (gte-small ties; the smaller options trade quality *down*), and you can't squeeze a transformer under ~15 MB — so **ship `bge-small-en-v1.5` int8 (~34 MB, first-run download + cache) as the quality-safe v1 default.** The genuine "bundle it" option is a **static embedding** (Model2Vec **potion-base-8M**, ~7.6 MB, CPU-only, ~instant, offline) — **benchmark it in parallel, but on your *actual* cosine-prototype eval, not MTEB Classification.** The trap: static's *classification* gap looks tiny (~4 pt), but T0's "max-cosine to prototypes" is a *similarity/nearest-centroid* task that maps to MTEB **STS/Clustering** (where the honest gap is ~9 pt) — and any retrieval-flavored step (dedup, similarity-segmentation) hits a ~20 pt cliff. If potion holds within a couple points on *your* task, ship it bundled and drop the download (a real UX win) — noting its pooling is Zipf/SIF frequency-weighted + L2-normalized, so a faithful pure-JS port must replicate that, not a uniform mean.

Independently, apply **Matryoshka truncation → 256-dim + int8 vector quantization** to keep the per-transcript IndexedDB footprint tiny *regardless of model* (these shrink the *vector*, not the download). **When the better option arrives:** `granite-embedding-small-english-r2` (~52 MB, 8192-ctx, ties bge on retrieval, much stronger on code) is a light step-up for code-heavy chats; `EmbeddingGemma-300m` (~175 MB q4f16, multilingual, MRL→256) is the "max on-device quality when download budget allows" opt-in.

---

## 13. Sources & Confidence

Researched 2026-07-01 from primary docs/repos/registries: Chrome for Developers (sidePanel, offscreen, CSP, storage, CWS API, SW lifecycle, WebGPU-124), MDN WebExtensions + browser-compat-data (sidebarAction, background, quotas/eviction), Apple Safari Web Extensions docs + WebKit blog/Bugzilla; provider DOM via community exporters + **live Gemini inspection**; Hugging Face Transformers.js v3/v4 docs + blog + model cards + npm/HF-API sizes, WebLLM/MLC + XGrammar, MTEB, Model2Vec, arXiv (JSONSchemaBench, DECODE); VS Code API (webview, chat, language-model, terminal shell execution), JetBrains JCEF docs, on-disk agent transcripts via **primary inspection on this machine**; wxt.dev, Turborepo/Nx, Preact/Solid/Svelte releases, Dexie, Vitest/Playwright, web-ext, store policies. The forward-looking round (§12) additionally drew on: OpenAI/Anthropic export + Compliance docs, Google Data Portability API scopes, GDPR/EU Data Act/DMA primary texts, the Data Transfer Initiative, gpuweb implementation-status + browser release notes, and WECG issue trackers.

Confidence marks reflect primary-source verification. **The most drift-prone items** — provider selectors, MV3 SW timings, WebGPU-by-platform, Safari packaging/storage, vendor JSONL schemas — are flagged **[M]/[L]** and should be re-verified at implementation time.
