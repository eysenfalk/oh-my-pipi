# Token Efficiency Research — oh-my-pipi Coding Agent

Exhaustive catalog of token reduction techniques for LLM coding agents, with cache economics analysis and a prioritized implementation roadmap. Techniques are assessed against the existing codebase; already-implemented items are noted.

---

## Already Implemented

- **Dynamic Context Pruning (DCP)**: deduplication, purge-errors, supersede-writes — see `src/session/context-pruning/ARCHITECTURE.md`
- **Compaction**: threshold-based LLM summarization with branch summarization
- **Compress tool**: agent-triggered selective range summarization
- **Tool output spilling**: TailBuffer streaming, OutputSink file spillage for >50 KB artifacts
- **Anthropic cache_control**: ephemeral cache with optional 1 h TTL, 4 breakpoints

---

## Cache Economics (Read This First)

Every technique must be evaluated against its cache impact, not just raw tokens saved. A technique that saves 40 % of input tokens but drops cache hit rate from 90 % to 30 % is a net loss.

### How Anthropic Prefix Caching Works

- **Prefix matching**: cryptographic hash of serialized request up to each breakpoint. Single byte change → cache miss from that point forward.
- **Hierarchy**: tools → system → messages. Changes at any level invalidate all downstream.
- **Breakpoints**: max 4 per request. Our placement: last tool block → last system block → penultimate user message → last user message.
- **Lookback**: system checks up to 20 blocks backward from a miss for partial prefix hits.
- **TTL**: 5 min (API/Pro, refreshes on hit), 1 h (Max plans, 2× write cost).
- **Minimum**: 1 024 tokens for Sonnet; 2 048–4 096 for Opus/Haiku.

### Real-World Numbers (Production Claude Code)

| Metric | Value |
|---|---|
| Cache hit rate | 84–96 % |
| Prefix reuse rate | 92 % |
| Cache read : I/O token ratio | 1 310 : 1 |
| Cost reduction from caching | 74–90 % |
| ITPM multiplier at 80 % hit rate | 5× |

**Cost formula:**
```
total_cost = (cache_write × 1.25 × base) + (cache_read × 0.1 × base) + (uncached × 1.0 × base)
```

Break-even: a cache write pays off after 2 reads (1.25 / 0.1 = 12.5 full ROI, but net savings start at read 2).

### Plan Implications

**API plan**: cache read = 0.1×, write = 1.25×, uncached = 1.0×. Techniques that reduce tokens AND preserve cache are double wins. Techniques that reduce tokens but break cache may be net negative.

**Max 20× plan**: fixed fee; cache reads count against quota at reduced weight; 1 h TTL is more forgiving. Converting cache reads into cache writes is catastrophically expensive — 99.93 % of tokens in production Claude Code are cache reads.

**ITPM rate limits**: cached read tokens do NOT count toward ITPM. 80 % hit rate → effective 5× throughput multiplier. Cache-breaking mutations cost 5× throughput.

### Our DCP Strategies: Cache Stability

**The root cause is strategy recalculation on every request, not just retroactive modification.**

OpenCode DCP (the reference implementation, 1 483 GitHub stars) documents this directly:

> "Deduplication … Recalculated when the compress tool runs, so prompt cache is only impacted alongside compression."
> "In testing, cache hit rates were approximately 85% with DCP vs 90% without."
> — https://github.com/Opencode-DCP/opencode-dynamic-context-pruning

Their architecture:
- Strategies (`deduplicate`, `purgeErrors`) run **only when the compress tool fires**
- Prune marks are **persisted to disk** as JSON after each compress invocation
- On every LLM request, the hook loads the persisted marks and applies them — deterministically, same marks every time until compress runs again
- Result: prefix is **stable** between compress invocations → 85% cache hit rate
- Note: `supersedeWrites` is commented out in their compress.ts, so it doesn't run at compress time

**Our oh-my-pipi DCP does the opposite:**
- Strategies run on **every `transformContext` call** (every LLM request)
- `currentTurn` is recomputed fresh from message count on each call
- No persistence — marks live in memory, recomputed from the message array each turn
- purge-errors crosses age thresholds on each new turn; dedup marks new duplicates on each new turn
- Result: prefix changes far more frequently → cache hit rate significantly below 85%

| Strategy | OpenCode DCP behavior | Our behavior | Our cache impact |
|---|---|---|---|
| **Deduplication** | Runs only on compress. Protected tools exempt. | Runs every request. | **UNSTABLE**: marks change whenever a new duplicate appears |
| **Purge-errors** | Runs only on compress. | Runs every request; `currentTurn` advances each turn. | **UNSTABLE**: threshold crossed on new turns even without compress |
| **Supersede-writes** | Disabled in compress.ts (commented out). | Runs every request. | **UNSTABLE**: retroactive on every read-after-write |

### Proposed Fix: Persist-and-Recalculate-on-Compress

Adopt the OpenCode DCP architecture:

1. **Only run strategies when compress fires** (or an explicit trigger like `/dcp sweep`). Not on every `transformContext`.
2. **Persist prune marks** in session storage after each compress invocation.
3. **Load and apply persisted marks** deterministically on every request — no recalculation.
4. **Compaction resets marks** — when compaction fires, clear persisted marks (the summarized content is gone).

This is simpler than freeze-frontier and validated by production data: OpenCode DCP achieves 85% cache hit rate (vs 90% without DCP), a controlled 5% tradeoff accepted only when compress runs.

**Cost math (using OpenCode DCP's measured numbers):**
```
Without DCP:  100 K context × 0.90 cache hit = 90 K at 0.1× + 10 K at 1.0× = 9 K + 10 K = 19 K effective
With DCP:     70 K context × 0.85 cache hit  = 59.5 K at 0.1× + 10.5 K at 1.0× = 6 K + 10.5 K = 16.5 K effective

Net: ~14% cost reduction at 30% fewer raw tokens. DCP still wins, but narrowly.
The win grows as sessions lengthen and DCP removes more content.
```

**Key files for persist-on-compress implementation:**

| File | Change |
|---|---|
| `src/session/context-pruning/state.ts` | Add serializable mark store. Stop recalculating `currentTurn` on every call for strategy decisions. |
| `src/session/context-pruning/strategies/deduplication.ts` | Call only from compress handler, not from `syncStateFromMessages`. |
| `src/session/context-pruning/strategies/purge-errors.ts` | Same — compress-triggered only. |
| `src/session/context-pruning/strategies/supersede-writes.ts` | Consider disabling entirely (OpenCode DCP chose to disable) or compress-triggered only. |
| `src/session/context-pruning/pipeline.ts` | `applyPruneOperations` still runs every request (applies persisted marks). Only strategy calculation moves to compress. |
| `packages/ai/src/providers/anthropic.ts` | Export cache hit rate metrics from response usage. |
| `src/session/agent-session.ts` | Persist prune marks after compress completes. Clear marks after compaction. Track `usage.cacheRead`/`cacheWrite`. |
---

## Technique Catalog

### PROMPT COMPRESSION

#### 1. LLMLingua
- **Source**: https://github.com/microsoft/LLMLingua
- **How it works**: Small aligned LM (GPT-2 or LLaMA-7B) classifies token importance via perplexity. Low-importance tokens removed with budget-aware allocation.
- **Token savings**: up to 20× with ~1.5 % performance loss
- **Complexity**: Medium (requires running a separate model)
- **Cache impact**: NEUTRAL (preprocessor)
- **Worth it?**: Maybe — latency of a second model rarely pays off for interactive agents. Best for batch/offline.

#### 2. LLMLingua-2
- **Source**: https://github.com/microsoft/LLMLingua
- **How it works**: Replaces GPT-2 with a BERT-level encoder. 3–6× faster than LLMLingua-1, comparable compression.
- **Token savings**: comparable to LLMLingua-1
- **Cache impact**: NEUTRAL
- **Worth it?**: Maybe — lower latency makes it more viable than v1.

#### 4. KIComp (Key-Information Density)
- **Source**: https://www.sciencedirect.com/science/article/pii/S0950705125004836
- **Token savings**: 75 % token reduction
- **Complexity**: Medium-High; paper only, no open implementation
- **Worth it?**: Maybe.

#### 5. Meta-Tokens (Lossless LZ77-Like)
- **Source**: https://arxiv.org/abs/2506.00307
- **How it works**: LZ77-style dictionary compression at token level. Repeated sequences → references to earlier occurrences. Lossless.
- **Token savings**: 27 % average
- **Complexity**: Low-Medium (algorithmic, no ML)
- **Cache impact**: DESTROYS if applied retroactively; SAFE if applied once at initial context load
- **Worth it?**: Yes — lossless, low latency, no quality risk. Effective for coding contexts with repeated imports/types/boilerplate. No open implementation yet.

#### 7. PromptOptMe
- **Token savings**: 2.37× with no quality loss
- **Worth it?**: Maybe — useful as a one-time pass on the static system prompt.

---

### ENCODING TRICKS

#### 12. Code Formatting Removal
- **Source**: https://arxiv.org/abs/2508.13666
- **How it works**: Remove non-semantic formatting (newlines dominate: 14.6–17.5 % savings). Language-dependent: Java 14.7 %, C# 13.2 %, Python 4.0 %.
- **Token savings**: 4–14.7 % input; 27.2 % output when prompting for unformatted output
- **Complexity**: Low (string manipulation)
- **Cache impact**: SAFE if applied at insertion time before first cache write; DESTROYS if applied retroactively
- **Worth it?**: Yes — apply at tool result insertion time, never retroactively.

#### 13. Code Minification
- **Source**: TU Wien thesis (Hrubec 2025)
- **Token savings**: 42 % input, but 12 % resolution rate drop
- **Worth it?**: Maybe — use selectively for non-primary-edit files.

#### 14. TOON (Token-Oriented Object Notation)
- **Source**: https://github.com/toon-format/toon
- **Token savings**: 39.9 % vs. JSON for uniform arrays
- **Worth it?**: Maybe — Markdown achieves similar savings with better model familiarity.

#### 15. Markdown Over JSON
- **Token savings**: 34–38 % vs. JSON
- **Cache impact**: SAFE — format chosen once, never changes
- **Worth it?**: Yes — audit all tool outputs currently returning JSON, switch to markdown where appropriate.

#### 16. CSV for Tabular Data
- **Token savings**: 40–50 % vs. JSON
- **Cache impact**: SAFE
- **Worth it?**: Yes — grep results, find results, directory listings.

#### 18. Constrained Decoding
- **Source**: https://www.aidancooper.co.uk/constrained-decoding/
- **How it works**: JSON Schema constrained decoding skips generating boilerplate. Only values sampled; structure is deterministic from schema.
- **Token savings**: 42 % output token reduction
- **Complexity**: Low (use provider structured output API)
- **Worth it?**: Yes — for tool call arguments and structured model output. Provider-native, zero overhead.

---

### CONVERSATION MANAGEMENT

#### 22. AgentDiet (Trajectory Reduction)
- **Source**: https://arxiv.org/abs/2509.23586
- **How it works**: Removes useless, redundant, and expired trajectory items. Three categories: (1) useless — tool calls that contributed nothing, (2) redundant — repeated information, (3) expired — superseded by later actions.
- **Token savings**: 39.9–59.7 % input reduction, 21.1–35.9 % cost reduction, same performance (SWE-bench, Claude Sonnet 4, Gemini 2.5 Pro)
- **Cache impact**: DESTROYS (retroactive trajectory modification) — must be cache-aware
- **Worth it?**: Yes — our DCP handles (2) and (3) partially but misses (1) entirely.

#### 23. Focus Agent (Intra-Trajectory Compression)
- **Source**: https://arxiv.org/abs/2601.07190
- **How it works**: Agent prunes its own history during task execution. Identifies completed sub-goals and compresses their traces.
- **Token savings**: 22.7 % average, up to 57 % on exploration-heavy tasks
- **Worth it?**: Yes — complements compaction by being surgical. Exploration-heavy tasks (searching for the right file) benefit most.

#### 26. Observation Masking + Summarization Hybrid (JetBrains)
- **Source**: https://blog.jetbrains.com/research/2025/12/efficient-context-management/
- **How it works**: Replace old tool outputs with `[output masked — N tokens]`. Keep latest 10 turns raw. Optional: LLM summarize the masked batch.
- **Token savings**: ~50 % vs. no management; simple masking nearly matches expensive summarization
- **Cache impact**: SAFE only if monotonic (once masked, stays masked). Recency-based masking (mask age changes per turn) is UNSTABLE.
- **Worth it?**: Yes — the masking component is very high value, very low effort. Use monotonic masking only.

---

### TOOL OUTPUT FILTERING

#### 27. Tool Result Size Guard (Pre-History Interception)
- **How it works**: Intercept tool results before written to history. Apply per-tool-type size limits. Large results → truncated with header + tail preview.
- **Token savings**: 80–95 % for large outputs
- **Cache impact**: SAFE — applied at insertion time before caching
- **Worth it?**: Yes — single highest-ROI technique. Reduces both token count AND cache write cost. We have spill thresholds but no per-tool-type intelligent filtering.

#### 28. Deep Agents Filesystem Offload
- **How it works**: Output >20 K tokens → write to filesystem, return file path + 10-line preview. Model reads on demand.
- **Cache impact**: SAFE
- **Worth it?**: Partially implemented via OutputSink. Improve by providing structured previews instead of raw tail.

#### 30. jCodeMunch (AST Symbol Extraction via Tree-sitter)
- **Source**: https://github.com/jgravelle/jcodemunch-mcp
- **How it works**: Tree-sitter AST parsing → extract only relevant symbols instead of full file contents.
- **Token savings**: 95 %; FastAPI example 214 K → 480 tokens (99.8 %)
- **Cache impact**: SAFE
- **Worth it?**: Yes — we already have LSP integration. AST-level retrieval for structure queries massively reduces exploration tokens.

#### 31. Content-Aware Per-Tool-Type Summarizers
- **Source**: https://mcpservers.org/servers/jubakitiashvili/context-mem
- **How it works**: Different summarizers for different tool output types: grep results, file listings, error messages, etc. No LLM calls.
- **Token savings**: 99 % on raw tool output across full coding sessions
- **Cache impact**: SAFE (applied at insertion)
- **Worth it?**: Yes — we treat all tool outputs identically; type-specific filtering is high-impact.

#### 34. Content-Hash Deduplication
- **How it works**: Hash tool outputs; skip re-inclusion if identical content already in context. "Same content as turn N."
- **Cache impact**: UNSTABLE if applied retroactively (same issue as DCP dedup); SAFE if applied only at insertion (never for existing messages)
- **Worth it?**: Yes — extends dedup from call signatures to content (catches different calls returning same output).

---

### CACHING STRATEGIES

#### 35. KV-Cache / Prefix Caching (Provider-Level)
- Already partially implemented. Key gap: maximize hit rate by adopting OpenCode DCP's persist-and-recalculate-on-compress pattern.

#### 40. Append-Only Context Architecture
- **Source**: https://arxiv.org/abs/2601.06007 and Manus AI
- **How it works**: Never modify existing messages, only append. Context changes only on explicit compaction.
- **Cache impact**: MAXIMIZES cache hits — foundational
- **Worth it?**: Yes — audit all DCP mutations. The correct fix is the OpenCode DCP architecture: persist marks, only recalculate on compress.

#### 70. Deterministic Serialization
- **How it works**: Sorted JSON keys, stable message ordering, consistent formatting. Unstable serialization → cache misses on identical content.
- **Cache impact**: FOUNDATIONAL
- **Worth it?**: Yes — audit for non-deterministic elements (object key ordering, Set/Map iteration order).

---

### RETRIEVAL OPTIMIZATION

#### 42. Aider Repository Map (Graph-Based)
- **Source**: https://aider.chat/docs/repomap.html
- **How it works**: PageRank-style graph ranking on file dependency graph selects relevant code to fit a token budget. Defaults to ~1 K tokens.
- **Worth it?**: Yes — more principled than keyword search. We could build this from LSP references/definitions.

#### 44. Cursor Dynamic Context Discovery
- **Source**: https://cursor.com/blog/dynamic-context-discovery
- **How it works**: Only tool names loaded initially; full descriptions loaded on-demand when model selects a tool.
- **Token savings**: 46.9 % reduction in agent tokens for MCP tool runs
- **Cache impact**: SAFE if tool set is frozen at session start
- **Worth it?**: Yes — directly applicable to our MCP integration.

#### 67. Progressive Disclosure (Lazy Context Expansion)
- **How it works**: Tools return minimal results; agent requests detail only when needed. file list → file overview → function signatures → function bodies.
- **Cache impact**: SAFE
- **Worth it?**: Yes — design principle for all tools: always have a summary mode and a detail mode.

---

### ARCHITECTURE-LEVEL

#### 47. Tool Description Filtering / Dynamic Toolsets
- **Source**: https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2
- **How it works**: Dynamically select which tool definitions to include per request based on task context.
- **Token savings**: 50–80 % in typical workflows; up to 160× vs. static toolsets
- **Cache impact**: DESTROYS if tool set changes mid-session; SAFE if frozen at session start
- **Worth it?**: Yes — freeze tool list at session start, then apply description filtering within that frozen set.

#### 49. MCP Compressor (Atlassian)
- **Source**: https://github.com/atlassian-labs/mcp-compressor
- **How it works**: Wraps MCP servers with `get_tool_schema` + `invoke_tool`; schemas loaded only when needed.
- **Worth it?**: Yes — directly applicable to our MCP integration layer.

#### 53. Conditional System Prompt Sections
- **How it works**: Include tool-specific instructions only when that tool is in the active set.
- **Cache impact**: SAFE if system prompt is stable within a session
- **Worth it?**: Yes — pair with tool filtering (#47).

#### 58. Observation Masking (see Conversation Management #26)

#### 59. Model Routing (Complexity-Based)
- **How it works**: Route low-complexity tasks (exploration, simple edits) to cheaper models (Haiku, GPT-4o-mini); expensive tasks to frontier models.
- **Cache impact**: DESTROYS on model switch — route entire sessions, not individual turns
- **Worth it?**: Yes — especially for sub-agent tasks.

#### 66. Context Window Budget Partitioning
- **How it works**: Fixed budget zones: system prompt (10–15 %), tools (15–20 %), history (variable), response reservation. Enforce per-zone limits.
- **Cache impact**: SAFE if zones are stable
- **Worth it?**: Yes — we have `reserveTokens` but no per-zone budgeting.

#### 68. Context Rot Prevention
- **Source**: https://research.trychroma.com/context-rot
- **How it works**: Performance degrades measurably at 70 % context utilization; effective window often <256 K even in 1 M-token models. Compact at 70 %, warn at 85 %, force at 90 %.
- **Worth it?**: Yes — lower compaction threshold from 95 % to 70–85 %.

---

### COT COMPRESSION

#### 61. Chain-of-Thought Budget Control
- **Token savings**: 50–82.6 % reasoning token reduction depending on approach
- **Worth it?**: Maybe — prompting-based approaches (ask model to reason concisely) are free to try. Extended thinking budget control is provider-specific.

---

## Implementation Roadmap

### Tier 0: Cache Foundation (prerequisite for everything else)

| # | Technique | Why First |
|---|---|---|
| 0a | Cache hit rate monitoring | Can't optimize what isn't measured. Track `cache_creation_input_tokens` and `cache_read_input_tokens` per request. |
| 0b | Deterministic serialization audit | Find and fix non-deterministic key ordering in message serialization. |
| 0c | DCP: persist marks, recalculate only on compress | Stop recalculating strategies on every request. Persist prune marks. Only deduplicate/purge-errors when compress fires. This is how OpenCode DCP achieves 85% cache hit rate. |
| 0d | Stable tool definitions | Freeze tool list at session start. MCP tools added after first LLM call require session restart or logit masking. |

### Tier 1: High Impact, Cache-Compatible

| # | Technique | Impact | Cache Impact | Notes |
|---|---|---|---|---|
| 1 | Tool Result Size Guard at insertion time (#27) | Very High | SAFE | Reduces token count AND cache write cost simultaneously. Single highest-ROI technique not yet implemented. |
| 2 | Markdown/CSV serialization (#15, #16) | Medium | SAFE | Format chosen once, stable forever. |
| 3 | Code formatting removal at insertion time (#12) | Medium | SAFE | Strip before caching, never retroactively. |
| 4 | Context rot threshold adjustment (#68) | Medium | SAFE | Lower compaction trigger from 95 % to ~75 %. Compaction is a one-time cache cost; earlier = smaller context to re-cache. |
| 5 | Monotonic observation masking (#26) | High | SAFE | Once masked, never unmasked. Apply only to live zone. |

### Tier 2: Medium Impact, Cache-Aware

| # | Technique | Impact | Cache Impact | Notes |
|---|---|---|---|---|
| 6 | Per-tool-type output filtering (#31) | Very High | SAFE (at insertion) | Type-specific filtering: grep vs. file reads vs. shell vs. LSP vs. tests. |
| 7 | Tool description lazy loading (#47, #49) | High | SAFE if frozen at session start | Load once at session start, then freeze. |
| 8 | AST-level code retrieval (#30) | High | SAFE | Tree-sitter symbol extraction for exploration queries. |
| 9 | Compaction quality improvement | Medium | One-time cost | Better summaries → fewer compactions needed. |
| 10 | Session-level model routing (#59) | High | SAFE | Route whole sessions, not turns. |

### Tier 3: Significant Impact, Higher Effort

| # | Technique | Impact | Notes |
|---|---|---|---|
| 11 | AgentDiet trajectory analysis (#22) | High | Classify trajectory items as useless/redundant/expired. Cache-aware version needed. |
| 12 | Aider-style repository map (#42) | Medium | Graph-based code relevance ranking from LSP dependency graph. |
| 13 | Meta-Tokens lossless compression (#5) | Medium | Algorithmic LZ77 at token level. No open implementation; must build. |
| 14 | Constrained decoding (#18) | Medium | Use provider structured output APIs. Low effort, provider-native. |
| 15 | Progressive disclosure for all tools (#67) | Medium | Ensure every tool has summary mode. |

---

## Compound Strategies

### "Cache-First Context Hygiene" (Estimated 3–4× net cost reduction)

The highest-impact stack combines cache preservation with insertion-time filtering:

1. **DCP: persist-and-recalculate-on-compress** — stable prefix between compress invocations (OpenCode DCP pattern, measured 85% hit rate)
2. **Tool result size guard at insertion time** — large outputs filtered before entering context/cache
3. **Markdown serialization for tool outputs** — 34–38 % savings, format stable from first use
4. **Code formatting removal at insertion time** — strip before caching
5. **Monotonic observation masking** — once masked, stays masked
6. **Deterministic serialization** — stable JSON key ordering

These are not purely multiplicative; filtering reduces cache write cost but also reduces the denominator for cache savings. Realistic expectation: 3–4× cost reduction. Measurement after implementation is required.

For comparison, the current approach yields roughly 1.5–2× (20–30 % DCP token reduction × ~60 % cache hit rate).

### "Context Hygiene" (Estimated 40–60 % total token reduction)

For non-Anthropic providers or short sessions where cache doesn't amortize:

- **Per-tool-type filtering** (#27) — type-aware size limits on new outputs
- **Content-hash dedup** (#34) — skip identical content re-inclusion (at insertion only)
- **Markdown serialization** (#15) — 34–38 % format savings
- **Code formatting removal** (#12) — 4–14.7 % additional savings on code

### "Smart Retrieval" (Estimated 60–80 % reduction in exploration tokens)

- **AST-level retrieval** (#30) — symbols not files
- **Progressive disclosure** (#67) — summary → detail on demand
- **Repository map** (#42) — graph-ranked relevance
- **Tool description filtering** (#47) — only active tools in context

---

## Key Insights

1. **Cache hit rate is king.** With 100:1 input-to-output token ratios in coding agents, Manus AI identifies KV-cache hit rate as the single most important production metric. Claude Code achieves 90–96 % through disciplined append-only design. Our retroactive DCP pruning likely costs us 20–40 percentage points.

2. **Simplicity often wins.** JetBrains found simple observation masking performs nearly as well as expensive LLM summarization at essentially zero cost. Start with the cheapest technique in each category.

3. **99 % of tokens are input.** Output token optimization matters far less than input management. Cache optimization is the highest-leverage move on the input side.

4. **Don't recalculate on every request.** OpenCode DCP achieves 85 % cache hit rate (vs 90 % without DCP) by running strategies only when compress fires and persisting the marks. Recalculating on every `transformContext` call — which is what our DCP does — breaks the prefix far more often than necessary. The measured cost of doing it right is a controlled 5 % delta, not 20–40 percentage points.

5. **The biggest gap is type-specific tool output filtering.** Every coding agent treats all tool outputs identically. Grep results, file reads, shell output, LSP responses, and test output have fundamentally different structures and optimal compression strategies. This is the highest-ROI unimplemented area.

6. **70 % is the danger zone.** Context performance degrades measurably at 70 % utilization, not at the technical window limit. Compaction at 95 % is too late.

---

## Gap Analysis

**Well-covered**: Prompt compression (many techniques, most require model hosting), conversation management (masking → trajectory optimization spectrum), caching strategies (provider-level, well-understood).

**Under-explored**:
- **Tool output filtering (type-specific)**: concept is established (context-mem, RTK) but per-tool-type strategies for our specific tool set need concrete specification.
- **Output token reduction**: most research focuses on input. Constrained decoding and CoT budget control are the only practical findings.
- **Code-specific retrieval**: RAG literature focuses on documents. AST-aware retrieval at symbol granularity is under-implemented despite tree-sitter being available.

**Emerging categories**:
- **Cache-aware context design** — managing context structure to maximize prefix cache hits is its own discipline, and our DCP is currently working against it.
- **Trajectory quality analysis** — classifying which past actions contributed to task success vs. were wasted. AgentDiet and Focus Agent pioneer this; we have no equivalent.
