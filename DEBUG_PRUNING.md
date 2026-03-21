# Context Pruning Debug Notes

Branch: `dev` — last commit `ed780227`

## Bug: compress tool reports "0 tokens saved"

### Symptom
Calling `compress({ topic: "...", summary: "..." })` returns:
> "Compressed context up to turn 0: ... 0 tool calls will be hidden."

`turn = 0` and nothing gets compressed.

---

## Root Cause Analysis

### Bug 1: `currentTurn = 0` in compress tool

**File:** `packages/coding-agent/src/tools/compress.ts` line 47
```typescript
const stats = this.#session.getPruningStats?.();
const currentTurn = stats?.currentTurn ?? 0;
```

**File:** `packages/coding-agent/src/session/agent-session.ts` lines 1999–2006
```typescript
getPruningStats(): PruningStats {
    return {
        tokensSaved: this.#pruneState.stats.tokensSaved,
        toolsPruned: this.#pruneState.stats.toolsPruned,
        currentTurn: this.#pruneState.currentTurn,   // ← reads live state
        compressions: this.#pruneState.compressions.length,
    };
}
```

`this.#pruneState.currentTurn` is set by `syncStateFromMessages()` in `pipeline.ts`, which runs inside `applyContextPruning()`, which runs inside `#transformContext`.

`#transformContext` fires BEFORE the LLM call. When compress tool executes (during tool execution phase), `#pruneState.currentTurn` SHOULD already reflect the correct turn count.

**However** — the pipeline has an early return:
```typescript
// pipeline.ts line 39
if (!config.enabled || messages.length === 0) return messages;
syncStateFromMessages(state, messages);   // ← turn IS set here, before second early return
```

`syncStateFromMessages` IS called before the second early return. So `currentTurn` should be > 0 if user messages exist.

**Unresolved question:** Why is `currentTurn = 0`? Candidates:
1. `this.#session.getPruningStats` is `undefined` at compress call time (ToolSession wiring not reaching the right instance)
2. `agent.state.messages` at transformContext time doesn't include the user messages from this session (messages passed to transformContext might be filtered/different from what we expect)
3. `syncStateFromMessages` counts `msg.role === "user"` but the actual user messages in AgentMessage[] use a different role string

**Where to check:**
- `packages/coding-agent/src/sdk.ts` lines 902–903: confirms `addCompression` and `getPruningStats` ARE wired in SDK path
- Need to verify omp's CLI interactive mode goes through `sdk.ts` createAgentSession and not a different code path
- Add a debug log in `syncStateFromMessages` to print the role of each message and the resulting `currentTurn`

**Quick diagnostic:** Add `logger.debug("syncState", { currentTurn: userMessages, roles: messages.map(m => m.role) })` to `syncStateFromMessages` and check `~/.omp/logs/omp.*.log`

---

### Bug 2: `upToTurn = currentTurn` covers nothing when turn is wrong

`applyCompressions()` in `prune.ts` line 63:
```typescript
if (meta.turn > record.upToTurn) continue;
```

If `record.upToTurn = 0`, only tool calls with `turn = 0` are covered. In practice no tool calls have `turn = 0` because turn counting starts at 1 (first user message = turn 1).

**Fix candidate:** Change compress tool to use `upToTurn: Number.MAX_SAFE_INTEGER` to cover ALL existing tool calls regardless of turn. The compress intent is always "compress everything that exists now" — not a specific range.

```typescript
// compress.ts
const record: CompressRecord = {
    topic,
    summary,
    upToTurn: Number.MAX_SAFE_INTEGER,  // cover all existing tool calls
    applied: false,
    coveredIds: [],
};
```

---

### Bug 3: Token savings from compression not tracked

**File:** `packages/coding-agent/src/session/context-pruning/prune.ts` line 79
```typescript
// Remove covered IDs from pruneMap to avoid double-processing
for (const id of allCoveredCallIds) state.pruneMap.delete(id);
```

When IDs are removed from `pruneMap`, the stats computation in `pipeline.ts` loses them:
```typescript
// pipeline.ts lines 42–47
state.stats.toolsPruned = state.pruneMap.size;    // ← excludes compressed IDs
let total = 0;
for (const tokens of state.pruneMap.values()) total += tokens;
state.stats.tokensSaved = total;                   // ← excludes compressed tokens
```

Compressed tool calls disappear from `pruneMap` before stats are computed, so they never appear in `tokensSaved`.

**Fix:** In `applyCompressions()`, accumulate token savings from covered IDs into a separate counter and add to `state.stats.tokensSaved`:
```typescript
// In applyCompressions(), after discovering covered IDs:
let compressionTokens = 0;
for (const id of allCoveredCallIds) {
    compressionTokens += state.toolMetadata.get(id)?.tokenCount ?? 0;
    state.pruneMap.delete(id);
}
state.stats.tokensSaved += compressionTokens;
state.stats.toolsPruned += allCoveredCallIds.size;  // also count compressed as "pruned"
```

---

## Summary of Fixes Needed

| # | File | Change |
|---|------|--------|
| 1a | `compress.ts` | `upToTurn: Number.MAX_SAFE_INTEGER` instead of `currentTurn` |
| 1b | `state.ts` / `syncStateFromMessages` | Add debug log to diagnose why `currentTurn = 0` |
| 2 | `prune.ts` / `applyCompressions` | Accumulate token savings before deleting from pruneMap |
| 3 | `pipeline.ts` | Ensure `state.stats.tokensSaved` includes compression savings |

Fix 1a is the safest and most impactful: makes compress cover everything regardless of turn tracking. Fix 2 makes the reported savings accurate.

The `currentTurn = 0` mystery (Bug 1) needs a debug log to confirm the root cause before fixing it.

---

## Files in play

```
packages/coding-agent/src/
  session/context-pruning/
    types.ts          — CompressRecord, PruneState, PruningStats
    state.ts          — syncStateFromMessages (sets currentTurn)
    prune.ts          — applyCompressions (bug 3 here)
    pipeline.ts       — stats computation (bug 3 here)
  tools/compress.ts   — upToTurn: currentTurn (bug 1+2 here)
  session/agent-session.ts — getPruningStats(), #transformContext wrapper
  sdk.ts lines 902-903 — ToolSession wiring (addCompression, getPruningStats)
```

## Test command
```bash
cd /home/aemon/git-repos/oh-my-pipi
bun test packages/coding-agent/test/context-pruning.test.ts
bun check:ts
```
