# dsh-cwl

**CWL — Context Window Lifecycle** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
structured context eviction for long-horizon agents.

> Paradigm: [*Beyond Compaction: Structured Context Eviction for Long-Horizon Agents*](https://arxiv.org/abs/2606.11213) (arXiv:2606.11213, Kiz8)

## Why not summarization compaction?

Compaction (the standard response to context pressure) summarizes history with an LLM.
Four structural problems (per the CWL paper):

- **Unpredictable lossiness** — the summarizer decides what matters, not the task.
- **Structural destruction** — causal chains (tool call → output → decision → action) collapse into prose.
- **Blocking cost** — a full LLM call fires mid-task, under token pressure.
- **Compression-induced hallucination** — summarization under length pressure is a known failure mode.

CWL treats the transcript as a **structured record of work** and evicts deterministically:
the agent's trajectory is inferred into a **typed episode graph** (exploration `expl` / action `act`,
with dependency edges), and when context pressure exceeds budget, a **zero-LLM, deterministic policy**
strips content in graduated levels — exploration episodes first (pure context, safest), then action
episodes whose effects are already persisted. **User messages are never evicted.**

## How it works

1. **Episode inference (automatic, no agent annotation needed)**: consecutive same-type tool
   batches merge into semantic episodes (`expl` for read/search, `act` for bash/edit/write);
   an `act` that touches files an earlier `expl` read gets a dependency edge.
2. **Pressure metering**: real context pressure = input + cacheRead + output + reasoning tokens
   (accumulated from `assistant/message` usage events — `tokenMeter.measure().totalTokens` omits
   cacheRead, which dominates long sessions).
3. **Graduated eviction** on the `agent/pre-step` waterfall (before every LLM call):
   - evict unexplored-dependent `expl` episodes first (keeping a one-line "explored: …" marker)
   - then oldest completed `act` episodes
   - never touch the newest tail (preserve-recent) or user messages
   - evicted ranges are replaced with a lightweight marker via the official surface-replace seam
     (original events stay in the log; `cwl_recall` can restore file paths).

## Install

```bash
dsh plugin --profile <name> add github:kalifun/dsh-cwl
```

Or vendor the directory and add to your composition:

```yaml
- id: dsh-cwl
  name: ./dsh-cwl/index.js
```

## Usage

No configuration needed. It stays completely inert while context is under budget
(default 80% of the model's context window), and starts evicting only when pressure
exceeds budget.

```bash
# Optional: override the budget (tokens) — for testing pressure behavior
HELMSMAN_CWL_BUDGET=30000 dsh web
```

Agent-facing tools:

| Tool | Purpose |
|------|---------|
| `cwl_mark` | (optional) manually annotate episodes for finer-grained control |
| `cwl_recall` | list file paths touched by evicted episodes, to re-read on demand |

Observability:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/cwl/evictions` | eviction log (session → episodes evicted) |
| `POST /api/cwl/force` | debug: force one eviction on a session |

## Verification

```bash
node check.js          # pure-function unit checks
```

Long-session pressure test (12 rounds of dialogue, ~200K cacheRead tokens):
`baseline vs CWL` — see `benchmarks/` in the source repo for scripts and reports.

| metric | baseline | CWL | Δ |
|--------|----------|-----|---|
| steps | 30 | 26 | −13% |
| inputTokens | 28,478 | 10,343 | **−64%** |
| cacheReadTokens | 200,576 | 178,432 | −11% |
| outputTokens | 2,809 | 2,107 | −25% |

All 12 rounds completed correctly; eviction did not degrade task quality.

## License

MIT
