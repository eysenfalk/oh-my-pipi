# Context Pruning & Dynamic Compression — Architecture

## What It Is

Context pruning reduces the token footprint of the conversation by identifying
redundant tool calls and replacing or removing them before messages reach the LLM.
Dynamic compression goes further: the agent can call the `compress` tool to
summarize a batch of tool calls into a short narrative, which replaces those calls
in the LLM's view.

Both features are transparent — they operate in `transformContext` before the LLM
call and never mutate the original `agent.state.messages`.

## Pipeline Flow

```
User calls session.prompt("...")
  └─ Agent loop (agent-loop.ts)
       ├─ config.transformContext(messages)      ← AgentMessage[] → AgentMessage[]
       │    └─ AgentSession.#transformContext
       │         ├─ extensionRunner?.emitContext  ← optional extension hook
       │         └─ applyContextPruning           ← THIS MODULE
       │              ├─ syncStateFromMessages    ← discover tool calls, compute turns
       │              ├─ strategies (if dirty)    ← deduplication, purgeErrors, supersedeWrites
       │              ├─ applyPruneOperations      ← replace arguments with "[pruned]" notice
       │              └─ applyCompressions         ← remove covered tool calls, inject summaries
       ├─ config.convertToLlm(messages)           ← AgentMessage[] → Message[]
       ├─ normalizeMessagesForProvider             ← strip thinking for Cerebras
       └─ streamFn(model, context)                ← send to LLM
```

### Where the transform is wired

The `AgentSession` wraps whatever `transformContext` is passed in config with
`applyContextPruning`. But `AgentSession.#transformContext` is private and only
callable via `session.convertMessagesToLlm()`.

The `Agent` class has its own `transformContext` that is called in the main loop.
These two must be connected:

```typescript
// In sdk.ts, after creating both Agent and AgentSession:
agent.transformContext = session.getContextTransform();
```

This replaces the Agent's prior transform (just the extension hook, or undefined)
with the session's full pipeline (extension hook → applyContextPruning).

**Why not pass it in the Agent constructor?**
The AgentSession doesn't exist yet when the Agent is constructed (chicken-and-egg).
The `Agent.transformContext` setter (added for this purpose) allows post-construction
wiring.

## Pruning Strategies

### Deduplication
Marks duplicate non-protected tool calls (same name + same arguments) for pruning.
The first occurrence is kept; subsequent duplicates have their arguments replaced with a
"[pruned]" notice. Protected tools (read, write, edit, etc.) are excluded.

### Purge Errors
After a configurable turn delay, replaces the arguments of errored tool calls with
the pruned notice. The error result stays visible so the LLM knows what failed.

### Supersede Writes
When the same file is written/edited multiple times, keeps only the latest write
and prunes earlier ones.

### Strategy execution: dirty flag
Strategies run **only when `state.strategiesDirty` is true**. The flag is:
- `true` on fresh sessions (first compress call will trigger strategies)
- Set `true` by `addCompressionRecord` (compress tool fired)
- Set `true` by `sweepContextPruning` (explicit user sweep)
- Cleared to `false` inside `applyContextPruning` after strategies run

This preserves prompt cache prefix stability between compress invocations: the
serialized prefix is byte-identical across turns, so the provider cache hits.
OpenCode DCP (the reference implementation) measures 85% cache hit rate with this
approach vs 90% without DCP — a controlled 5% tradeoff.

### applyPruneOperations
Walks through all assistant messages and replaces the `arguments` field of pruned
tool calls with `{ _pruned: "[input pruned by context optimizer]" }`. This preserves
the content array structure — no blocks are added or removed. This is safe for
messages with thinking blocks because the array shape is unchanged.

## Dynamic Compression

When the LLM calls the `compress` tool:
1. `compress.ts` calls `session.addCompressionRecord({ topic, summary, upToTurn: MAX_SAFE_INTEGER })`
2. The record is stored in `state.compressions` on the AgentSession's `#pruneState`
3. On the next `transformContext` call (next LLM invocation), `applyCompressions`:
   a. Discovers which tool call IDs fall under the record's `upToTurn`
   b. Removes those tool calls from assistant messages and their matching tool results
   c. Injects a synthetic user message: `[Compressed: <topic>]\n\n<summary>`

### Token savings tracking
When compression covers IDs not already in the pruneMap, their token counts are
added to `state.stats.tokensSaved`. IDs already in the pruneMap are deleted
(to avoid double-processing with `applyPruneOperations`).

## Thinking Block Constraint (Critical)

**Anthropic requires the latest assistant message's thinking/redactedThinking blocks
to remain structurally identical to what the server returned.** These blocks carry
cryptographic signatures. Modifying the content array — adding, removing, or
reordering blocks — invalidates the signature and causes a 400 error:

```
messages.N.content.M: `thinking` or `redacted_thinking` blocks in the latest
assistant message cannot be modified
```

### How compression can violate this

When `applyCompressions` removes covered tool call blocks from an assistant message
that also contains thinking blocks, it creates `{ ...msg, content: [thinkingBlock] }`
— a structurally different message. If this message is the **latest** assistant
message, the API rejects it.

### The guard

`applyCompressions` identifies the last assistant message in the array. If it
contains any `thinking` or `redactedThinking` blocks AND has covered tool calls,
it skips modification entirely — the original message reference is pushed unchanged.
The covered IDs remain tracked and will be removed on the next call, when a newer
assistant message takes over as "latest".

The corresponding tool result messages for deferred tool calls are also preserved
to maintain message consistency.

### Why earlier messages are safe

Non-latest assistant messages with thinking blocks are handled by
`transformMessages` (in the `ai` package). It converts their thinking blocks to
plain text or strips them entirely (line 54: `mustPreserveLatestAnthropicThinking`
only protects the latest). So by the time `applyCompressions` removes tool calls
from a non-latest message, its thinking blocks are already gone (converted to text)
in the downstream pipeline.

### Timeline of a deferred compression

```
Turn N:
  - Agent produces assistant [thinking, toolCall_A]
  - User adds compression record
  - transformContext runs: toolCall_A is covered, BUT this is the latest
    assistant message with thinking blocks → SKIP. Tool call stays. No summary
    injected.

Turn N+1:
  - Agent produces a new assistant message (text or tool call)
  - transformContext runs: Turn N's assistant is no longer the latest →
    toolCall_A is removed, summary "[Compressed: ...]" injected.
    transformMessages converts Turn N's orphaned thinking blocks to text.
```

### applyPruneOperations is safe

Unlike `applyCompressions`, `applyPruneOperations` never adds or removes blocks.
It only replaces the `arguments` field within existing tool call blocks. The content
array structure is identical, so thinking block signatures remain valid.

## Testing

### Unit tests (`context-pruning.test.ts`)

Test `applyCompressions`, `applyPruneOperations`, strategies, and
`applyContextPruning` pipeline in isolation. No LLM calls, no Agent/Session setup.

Key helpers:
- `makeToolCall(name, args)` — assistant with one tool call
- `makeThinkingToolCall(name, args)` — assistant with thinking + tool call
- `makeToolResult(id, name)` — tool result message
- `makeCompressRecord(topic, summary)` — compression record

### E2E tests (`context-pruning-sdk.test.ts`)

Full pipeline with mocked LLM via scripted `streamFn`. Exercises
`session.prompt()` → Agent loop → `transformContext` → `convertToLlm` → `streamFn`.

Key pattern — mocked streamFn:
```typescript
const agent = new Agent({
    streamFn: (_model, context, _options) => {
        // context.messages is the LLM-format array AFTER transformContext + convertToLlm
        capturedContexts.push([...context.messages]);
        const response = scriptedResponses.shift() ?? makeAssistantTextMessage("done");
        return mockStream(response);
    },
    convertToLlm,
    // ...
});

const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
// Wire the transform pipeline AFTER both are constructed:
agent.transformContext = session.getContextTransform();
```

This pattern mirrors the SDK's production wiring (sdk.ts line where
`agent.transformContext = session.getContextTransform()` is called).

### Wiring tests (`context-pruning-sdk.test.ts`, first describe block)

Use `createAgentSession()` (no LLM) to verify `addCompressionRecord` and
`getPruningStats` are properly exposed and wired.

## Known Pitfalls

### 1. Agent ↔ AgentSession chicken-and-egg
The Agent is created before the AgentSession. The session's `#transformContext`
(which includes `applyContextPruning`) must be wired back to the Agent via
`agent.transformContext = session.getContextTransform()` after construction.
Forgetting this means compression records are stored but never applied.

### 2. Double-application of transforms
If `transformContext` is passed to both the Agent constructor AND the AgentSession
constructor, and then the session's `getContextTransform()` is ALSO wired to the
Agent, the extension hook runs twice. The SDK avoids this by passing the extension
hook to AgentSession only, and wiring the combined transform to the Agent.

### 3. convertToLlm vs transformContext
`transformContext` operates on `AgentMessage[]` — the internal message format.
`convertToLlm` converts `AgentMessage[]` to `Message[]` — the LLM format.
Compression operates at the `AgentMessage[]` level (in `transformContext`), so
it modifies the internal representation before conversion.

### 4. Thinking blocks — the latest message constraint
See the "Thinking Block Constraint" section above. This is the most dangerous
pitfall. Any code that modifies assistant message content arrays must check
whether it's operating on the latest assistant message with thinking blocks.

### 5. Stats recalculation
`state.stats.tokensSaved` is recomputed from the pruneMap sum on each call to
`applyContextPruning` (pipeline.ts line 47). Compression tokens are added
separately by `applyCompressions`. IDs covered by compression are deleted from
the pruneMap, so they don't get double-counted. This works correctly but is
subtle — modifying the stats computation without understanding both paths will
break the accounting.


## Prune Mark Persistence

Pruning decisions (the `pruneMap` and `compressions` array) are persisted to a sidecar
file alongside the session JSONL file:

```
<sessionFile>.jsonl          ← conversation messages
<sessionFile>.prune.json     ← pruneMap + compressions (sidecar)
```

**Write path**: After strategies run in `applyContextPruning` (dirty flag transitions
`true → false`), `AgentSession.#transformContext` fire-and-forgets `#savePruneMarks()`.
Same after `sweepContextPruning()`.

**Read path**: `AgentSession.#transformContext` lazy-loads the sidecar on the very first
call for a session (guarded by `#pruneStateLoaded`). If the file doesn't exist (new session),
strategies will run on the first compress invocation as normal.

**Why this matters for cache**: Between compress invocations, `strategiesDirty` is `false`
and the pruneMap doesn't change. The serialized prefix is byte-identical on every turn
→ Anthropic prefix cache hits. Strategies only re-evaluate at compress time, which already
invalidates the prefix anyway (a new compression record changes the message structure).

**Sidecar format**:
```json
{
  "pruneMap": [["toolCallId1", 1234], ["toolCallId2", 567]],
  "compressions": [
    { "topic": "...", "summary": "...", "upToTurn": 9007199254740991, "applied": true, "coveredIds": [...] }
  ]
}
```

**If the sidecar is absent or unreadable** (ENOENT is silently ignored; other errors are
warned but not fatal): `strategiesDirty` stays `true` from `createPruneState()`, so
strategies run on the next compress invocation and write a fresh sidecar. No data loss.

### 6. Sidecar/session file mismatch
If a session file is copied or its path changes, the `.prune.json` sidecar travels with it
automatically (same stem, same directory). If only the sidecar is lost, strategies re-run
on next compress and reconstruct it. If only the session is lost, the sidecar is orphaned
but harmless (never loaded since there's no matching session path).