# SPEC — Embedder Eval Harness (`bge-small` vs `potion`)

*Status: **Draft — awaiting [USER GATE]**. Date: 2026-07-01. Informs the §10.1 / §12.7 decision in [`gpt-sidekick-architecture-and-research.md`](./gpt-sidekick-architecture-and-research.md) ("the companion doc"). Consumes labeled fixtures produced by the spike ([`SPEC.md`](./SPEC.md) M4).*

---

## 1. Purpose — the decision this harness makes

**Decision:** *Do we ship the Alpha T0 embedder as a **bundled static model** (`potion-base-8M`, ~7.6 MB, CPU-only, instant, offline) and drop the first-run download — or keep the **downloaded neural default** (`bge-small-en-v1.5` int8, ~34 MB)?*

Bundling potion is a real UX win (no ~34 MB first-run download, works with zero network, no model-host CSP allow-listing). The **only** question is whether potion's quality holds **on GPT-Sidekick's actual T0 operations** — not in the abstract.

**Threshold (decision rule, refined in §9):** ship potion bundled **iff** the **paired point-estimate** micro-F1 gap (bge − potion) is **≤ 2.0 pts** on the category task **and** the paired 95% CI upper bound does not admit a *large* gap (**≤ ~4 pts** — the guard against a lucky point estimate hiding a real regression) **and** segmentation doesn't degrade beyond a small margin. Otherwise keep bge-small (download) as default and hold potion as an opt-in "low-power/offline" mode (companion §7).

> **Two-bar caution (read before building §8/§9).** An earlier draft mixed a *point-estimate* ≤ 2 with an *upper-CI-bound* ≤ 2. Those are very different stringencies: at n≈300, requiring the **upper** CI bound ≤ 2 effectively demands potion *tie* bge (point estimate ≈ 0), so GO could be unreachable **by construction**, independent of potion's true quality. This spec uses **point-estimate ≤ 2 as the GO bar, with a wider upper-CI guard (≤ ~4)** so the rule is achievable yet still protected against noise. **Before committing to these numbers, §8 must confirm the harness can actually *resolve* a ~2-pt delta at the achieved n** (see the resolvability check); if it can't, expand the labeled set rather than decide on unresolvable noise.

---

## 2. The trap this spec exists to avoid — **do NOT use MTEB Classification**

Companion §12.7 is explicit and load-bearing: potion's headline *classification* gap looks tiny (~4 pt), but **MTEB Classification trains a logistic-regression head over the embeddings** — it measures *linear separability*, which is **not** what T0 does. T0 does **max-cosine to category prototypes** (nearest-centroid) and **cosine-drop segmentation** — both are *similarity / clustering* operations that map to **MTEB STS/Clustering**, where the honest static gap is ~9 pt, and any retrieval-flavored step (dedup) hits a ~20 pt cliff.

**Therefore the harness measures the real operations directly, on our data.** Any result quoted from an MTEB Classification subscore is inadmissible for this decision. This framing is non-negotiable; it is the whole reason a bespoke harness exists instead of reading a leaderboard.

---

## 3. Tasks measured (mirror T0 exactly)

### Task A — Category classification (nearest-centroid / max-cosine) — *primary*
The real T0 classifier: build a **prototype** per category (mean of L2-normalized anchor embeddings for that category), classify each snippet by **argmax cosine** to the prototypes (+ a "none/note" reject via a similarity floor). This is the operation the outline depends on.
- **Categories evaluated here: `{decision, action, question, artifact, code}` + `none`.** **`correction` is deliberately excluded** — production does **not** detect corrections by max-cosine-to-prototype; it routes them through the **pairwise NLI pipeline** (companion §12.6), where the embedder's only job is generating the candidate-pair *shortlist* (a retrieval task → Task D). Scoring correction under nearest-centroid would test something neither model does in production (a strawman).
- Metric: **per-category precision/recall/F1 + micro-avg** over those six labels.

### Task D — Correction candidate-pair shortlist (retrieval) — *the embedder's real correction-relevant job*
This is what the embedder actually contributes to correction detection (companion §12.6, step 1): for each later assistant sentence, does the top-k cosine shortlist of earlier sentences **contain the sentence it corrects**? This is a *retrieval* task — the ~20-pt-cliff regime where static is expected to be weakest — so measuring it here is exactly where the bge-vs-potion gap matters for corrections.
- Metric: **shortlist recall@k** (is the true corrected-sentence in the later sentence's top-k?) on labeled correction pairs.
- **Feasibility caveat:** corrections are rare, so enough labeled *pairs* may not come out of 3 spike conversations. If the pair count is below a usable floor, **report Task D as indicative-only (or skip with a written note)** — do not manufacture a decision from a handful of pairs. Task D never blocks the GO/NO-GO on its own; it informs it.

### Task B — Segmentation (cosine boundary detection) — *primary*
T0 segments by the **cosine similarity drop between consecutive turn/sentence embeddings**; a boundary is predicted where similarity dips past a threshold (tune threshold per model on a dev split — see §8).
- Metric: **Pk** and **WindowDiff** (standard text-segmentation metrics; lower = better) against labeled boundaries.

### Task C — Near-duplicate / similarity (retrieval-flavored) — *secondary, only if used*
Only if Alpha's design uses embedding similarity for dedup/merge of repeated items. This is where static is expected to fall off the ~20 pt cliff (companion §12.7), so **measure it explicitly rather than assume** — its result must be weighted heavily *if* the feature is in scope, and skipped (with a note) if not.
- Metric: precision@k / mAP on labeled duplicate pairs, or a simple threshold P/R on a hand-labeled dup set.

> **Rule:** the decision is dominated by A and B (which T0 always uses). C only enters if the Alpha spec commits to a similarity-dedup step; **name that dependency explicitly, don't silently include or exclude it.**

---

## 4. Dataset & labeling

**Source:** the labeled fixture subset emitted by the spike (SPEC.md M4) — real captured ChatGPT (and, once available, Claude) transcripts, canonicalized with the **same `canonicalize()`** the spike/Alpha use (so eval text == production text; a mismatch would invalidate the numbers).

**Labels (three label sets over the same snippets):**
1. **Category labels (Task A)** — each snippet ∈ `{decision, action, question, artifact, code, none}`. Include a healthy `none` set (the classifier must reject non-items). *(No `correction` label here — see set 3.)*
2. **Segment boundaries (Task B)** — for ≥ 2 full conversations, mark the turn indices where the topic/segment changes.
3. **Correction pairs (Task D, best-effort)** — where a later assistant sentence corrects/revises an earlier one, annotate the pair `(later → earlier)`. Expect *few* (corrections are rare); this feeds Task D as indicative, not decisive.

**Size floor (guard against deciding on noise):** ≥ **300 labeled snippets total**, ≥ **30 per Task-A category** for the non-code item categories (code is trivially rule-detected; still include some), and ≥ **2 fully boundary-labeled conversations** (≥ 40 turns each). If the spike can't produce this, that gap is a **blocker to a trustworthy decision** and is stated as such — we do not decide on 5 examples per class. **Correction pairs are explicitly exempt from the ≥30 floor** (rarity is expected); Task D runs only if enough pairs exist and is indicative regardless. Labeling protocol: single annotator for the spike is acceptable, but **commit the label guidelines** so it's reproducible; flag any category with < 30 examples as "insufficient — result indicative only".

**Splits:** anchors/prototypes and any threshold tuning use a **dev split**; final metrics are reported on a **held-out test split** the thresholds/anchors never saw. No peeking.

---

## 5. Models under test + the correctness gate

| Model | How run | Notes |
|---|---|---|
| **bge-small-en-v1.5** int8 | Transformers.js / ORT (feature-extraction, mean-pool, L2) | the incumbent default |
| **potion-base-8M** (static) | **faithful TS port** (see gate below) | the bundling candidate |
| all-MiniLM-L6-v2 int8 | ORT | reference / sanity anchor point |
| *potion-base-32M* (optional) | faithful TS port | if 8M is borderline, is 32M (~32 MB) worth it vs bge? |

### 5.1 The potion port correctness gate (must pass BEFORE any eval numbers are trusted)
Model2Vec/potion pooling is **NOT** a uniform mean — it is **Zipf/SIF frequency-weighted token averaging + L2 normalization** (companion §12.7). A naive mean-pool port would silently produce *wrong, worse* vectors and could **falsely sink potion**, causing us to reject a viable option for a porting bug — a classic green-but-broken trap.

**Gate:** implement `potionEmbed(text)` in TS (tokenizer + static token table from the model's `onnx/model.onnx` / distilled vectors + Zipf/SIF weighting + L2), then **validate it against golden reference outputs**: cosine( ourVector, referenceVector ) ≥ 0.999 on a fixed set of ≥ 20 probe strings. The eval is **blocked** until this gate is green. (This mirrors the spike's canonicalization linchpin: get the primitive provably right before measuring anything on top of it.)

> **On producing the golden vectors — the shipped/throwaway distinction.** The **shipped** potion path and the **eval runtime** are TS/Node (no Python) — that constraint stays. But the ≥20 **golden reference vectors are a one-time, offline test fixture**, and Model2Vec's canonical, trustworthy implementation is Python. Per the user's own CLAUDE.md corollary — *"a 'no Python in shipped crates' rule does not govern a throwaway benchmark/experiment repo"* — minting these golden vectors once from canonical Model2Vec (Python) and committing them as language-agnostic numbers **is** the sanctioned exception; do not weaken this gate to avoid it. First check whether a trustworthy **non-Python** golden source exists (e.g. a maintained JS Model2Vec impl or published fixtures); if one does, use it. If not, use Python **once** for the fixture only. The gate exists to stop a porting bug from *falsely sinking potion* — so it must be validated against a real reference, not a self-referential one.

---

## 6. Harness runtime

- **Node + onnxruntime-node** for bge/MiniLM (real vectors, matches a Node-run eval), and the TS potion port. Node is chosen so the harness runs headless in CI and against the full labeled set fast.
- **Browser-parity spot check (don't skip):** re-embed a ~30-snippet sample in the **actual browser WASM path** (the Alpha runtime) and assert cosine(node-vector, browser-vector) ≥ 0.999 per model. We ship in the browser; a decision made only on node vectors that diverge in-browser would be **another green-but-broken risk**. If they diverge, the browser numbers win.
- Deterministic: fixed anchor seed lists, fixed splits (seeded), no network at eval time (models cached locally).

---

## 7. Metrics & reporting

For each model, report:
- **Task A:** per-category P/R/F1 table + micro-F1 (six labels, no correction).
- **Task B:** Pk, WindowDiff.
- **Task C (if in scope):** P/R (or mAP) on the dup set.
- **Task D (if enough pairs):** shortlist recall@k on correction pairs — *indicative*.
- **Paired deltas:** `bge − potion` for every metric with a **95% CI**, direction noted (positive = bge better).

The headline artifact is a **delta table with confidence intervals** (§8), plus a one-paragraph honest read (which tasks decide it, where static gives up ground, whether the gap is within threshold).

---

## 8. Rigor — variance, not a single lucky split

Nearest-centroid quality depends on **which anchor sentences seed each prototype**, and F1 on a few-hundred-snippet set has real sampling noise. A single run is not a decision.
- **Anchor variance:** run **K ≥ 10** prototype seed sets (randomly sampled anchors per category from the dev split); report **mean ± std** of micro-F1 across seeds for each model.
- **Paired test-set CI (not unpaired):** bootstrap (≥ 1000 resamples) the test split, and on **each** resample compute **both models' F1 on that same resampled set**, then take the delta — a **paired** bootstrap. (Unpaired resampling inflates the delta CI and would bias us toward NO-GO for a porting/noise artifact rather than a real gap.) Report 95% CIs on each metric and on the paired `bge − potion` delta.
- **Resolvability check (do this first, it can invalidate the whole comparison):** estimate the half-width of the paired delta CI at the achieved n. **If the CI half-width exceeds the ~2-pt GO bar, the data cannot resolve the decision** — expand the labeled set (or widen the bar, explicitly) *before* running the comparison. Deciding on an unresolvable delta is the failure mode this guards against.
- **Decision uses the paired interval per §9:** GO needs the **point delta ≤ 2** *and* the **upper CI bound ≤ ~4** (not upper-bound ≤ 2, which is unreachable at this n — see §1). Same paired discipline for segmentation.
- Threshold tuning (Task B boundary cutoff) is done **per model on the dev split** so each model is shown at its own best — we compare tuned-vs-tuned, never handicap one.

---

## 9. Decision rule (explicit)

```
GO (ship potion bundled, drop the download) iff ALL:
  • Resolvability (§8): paired delta CI half-width ≤ the GO bar; else expand data first
  • Task A: paired (bge − potion) micro-F1 POINT delta ≤ 2.0 pts
            AND paired 95% CI upper bound ≤ ~4.0 pts   (achievable bar; see §1 two-bar caution)
  • Task B: potion Pk/WindowDiff within a small margin (≤ ~0.03 Pk) of bge
  • Task C: if a similarity-dedup step is in Alpha scope, potion within threshold there too;
            if not in scope, C is excluded WITH a written note
  • Port correctness gate (§5.1) and browser-parity (§6) both green
  • Task D (correction shortlist): INFORMS, does not block — if potion's recall@k is
            materially worse AND corrections matter to you, weigh toward NO-GO; note it

Otherwise NO-GO: keep bge-small (download) as default;
  offer potion as an opt-in "offline / low-power" mode (companion §7) — NOT a silent fallback.
```
Ambiguous outcome (delta straddles the threshold) → **NO-GO for default, keep as opt-in** and record the numbers; don't stretch the threshold to force a bundling win.

---

## 10. Anti-patterns / honesty notes (carry these into the writeup)

- ❌ Quoting MTEB Classification (or any linear-probe number) as evidence — inadmissible (§2).
- ❌ Uniform-mean potion port — must pass the §5.1 gate first.
- ❌ Deciding on node vectors without the browser-parity check (§6).
- ❌ Deciding on < 30 examples/category — flag as indicative-only, not decisive.
- ❌ Tuning bge's threshold but not potion's (or vice-versa) — tuned-vs-tuned only.
- ✅ Report the *task that dominates the decision* and where static honestly loses ground; if the answer is "close," prefer the conservative default (bge download) and keep potion opt-in.

---

## 11. Deliverables & layout

```
eval/
  embedder/
    data/                 labeled snippets + boundary labels (from spike M4; real captures git-ignored)
    label-guidelines.md   reproducible labeling protocol
    potion-port.ts        faithful Model2Vec pooling (Zipf/SIF + L2)
    potion-port.test.ts   §5.1 correctness gate (≥0.999 vs committed reference vectors)
    embed.ts              model runners (bge/MiniLM via ORT; potion via port)
    tasks/{classify,segment,dedup,correction-shortlist}.ts
    metrics.ts            P/R/F1, Pk, WindowDiff, bootstrap CI
    run.ts                orchestrates: K anchor seeds × models × tasks → results
    report.md             GENERATED: delta table + CIs + honest read + GO/NO-GO
```
`run.ts` emits `report.md` (the artifact for the [USER GATE]) and machine-readable JSON.

## 12. Milestones (each ends at codex review + [USER GATE])

1. **E0 — port + gate:** `potion-port.ts` passes §5.1 (≥0.999 vs reference) and browser-parity §6. *(No task numbers exist yet; this just proves the primitives.)*
2. **E1 — data:** labeled set from spike M4 meets §4 size floors; guidelines committed.
3. **E2 — tasks + metrics:** Tasks A/B (+C if scoped, +D if enough pairs) with **paired** bootstrap CIs and the §8 resolvability check; RED-first tests on synthetic mini-sets with known answers (a metric bug is caught here, not in the report).
4. **E3 — run + report:** full run, `report.md` with the §9 GO/NO-GO. Present at the gate.

## 13. [USER GATE] decisions — resolved 2026-07-02

1. **Similarity-dedup NOT in Alpha T0 scope → Task C excluded.** Alpha T0 stays purely extractive; dedup is by evidence overlap (same message/span), not semantic similarity (semantic multi-turn merge is a T1/T2 job). Per §3's rule, **Task C is excluded with this written note**; the GO/NO-GO rests on Tasks A (classify) + B (segment) — both always used by T0. *(If Alpha later adds a semantic dedup/merge step, re-open Task C — it's the ~20 pt static cliff, companion §12.7.)*
2. **Labeling → bootstrap + spot-correct.** The rules extractor seeds draft labels; the user spot-corrects. Single-annotator per §4; **`label-guidelines.md` must be committed** for reproducibility.
3. **Threshold → spec default:** point delta ≤ 2.0 F1 **and** paired 95% CI upper bound ≤ ~4.0 (§1/§9). If the achieved n can't resolve ~2 pts (§8 resolvability check), **expand the labeled set rather than coarsen the bar.**
