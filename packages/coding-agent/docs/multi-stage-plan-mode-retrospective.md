# Multi-Stage Plan Mode + Read-Only Toggle: Implementation Retrospective

## What We Built

Three new features added to the coding-agent:

1. **Multi-stage plan mode** — `/plan` and `/auto` now support an ordered pipeline of stages (`understand → design → review → plan`). Each stage has its own `local://` file and requires explicit approval before advancing. The final stage preserves the existing approval UX unchanged.

2. **Configurable stages** — `/workflow config` lets the user toggle which optional stages (understand, design, review) run before the mandatory plan stage. State persists in settings.

3. **Read-only mode** — `/read-only` is a system-level safety mode that technically enforces read-only at the tool level: file writes (`write`, `edit`/patch) throw `ToolError`, and bash execution is blocked entirely. The three modes (plan, auto, read-only) are mutually exclusive.

---

## Architecture Decisions and Why

### Why `isLastStage()` + `currentStage()` in `state.ts` instead of inline logic

These helpers are called from three different places: `exit-plan-mode.ts` (tool), `interactive-mode.ts` (approval dispatch), and `agent-session.ts` (prompt template vars). Inlining the same `(state.stages ?? ["plan"])[state.currentStageIndex ?? 0]` in each would create a maintenance fork. Centralizing in `state.ts` gives one place to fix if the default behavior needs to change.

The same logic governs backward compatibility: when no `stages` array exists (`PlanModeState` from before this change), `isLastStage` returns `true` and `currentStage` returns `"plan"`. Old sessions resume as single-stage with no behavior change.

### Why `write-guard.ts` as a rename of `plan-mode-guard.ts` with a re-export shim

The original function was called `enforcePlanModeWrite`. That name no longer described the full contract — the guard now also enforces read-only mode. Renaming to `enforceWriteGuard` in a new file `write-guard.ts` communicates what it actually does.

The shim (`plan-mode-guard.ts` re-exporting `enforcePlanModeWrite` as an alias for `enforceWriteGuard`) avoided a full cutover of all callers at once. However, the shim is a lie — it exists only to soften the migration. The correct call sites (`write.ts`, `patch/index.ts`) were updated to import from `write-guard.ts` directly. The shim remains for `exit-plan-mode.ts`'s `resolvePlanPath` import.

### Why read-only blocks bash entirely instead of just file writes

Plan mode relies on a prompt-level contract: "you trust the model to not run harmful commands." Read-only makes a *technical* guarantee, not a social one. If the point is to prevent any state changes before exploring a codebase, blocking file writes without blocking bash is theater — one `git checkout`, `npm install`, or database migration command and you've achieved nothing. The bash block makes read-only mode meaningful.

### Why three-mode mutual exclusivity at the UX layer, not at the tool layer

The tools themselves don't know about plan mode vs. auto mode vs. read-only at the command-entry level. The mutual exclusivity is a UX invariant: the user should never have two competing "what can I do?" modes active simultaneously. Enforcing this in `handlePlanModeCommand`, `handleAutoModeCommand`, and `handleReadOnlyCommand` is the right place — where the user intent is received. The tool-level guards only enforce their individual constraints; they don't know about each other.

### Why `title` is optional in `exit_plan_mode` schema

For intermediate stages (not the last one), the model has nothing to name — there's no final artifact yet. Requiring a title would force the model to invent one. Optional title with runtime validation (`if (!params.title) throw` when `isLastStage`) preserves the existing contract for the final stage while letting intermediate stages call `exit_plan_mode({})`.

### Why `#criticReviewStage` is a stub

The full critic dispatch requires spawning a sub-agent with the stage content and getting a binary approve/reject. This is non-trivial: it needs context about what the stage was supposed to produce, a critic prompt, and reliable parsing of the output. Shipping a stub that always returns `true` is honest about the deferred work while completing the plumbing — the retry loop, the error path, the state update all exist and are correct. Phase 4 fills in the stub without touching anything else.

### Why `#handleIntermediateStageApproval` and `#handleFinalStageApproval` are separate methods

The original `handleExitPlanModeTool` was a 50-line method that would have grown to 100+ lines absorbing both paths. The dispatch point (`if (details.isIntermediate)`) is now trivially obvious, and each path has a coherent single job. The split also enables testing each path independently.

### Why stages are stored in `PlanModeState` rather than recomputed from settings on each turn

Settings can change during a session. If a user enables a new stage mid-session, the active pipeline should not change — that would be confusing and potentially break the current stage index. Snapshotting at entry time in `#enterPlanMode` gives the session a stable, committed pipeline.

### Why the plan stage file path is now `stageFilePath(stages[0])` instead of `#getPlanFilePath()`

`#getPlanFilePath()` contained logic to use a default `local://PLAN.md`. For single-stage mode, `stages[0]` is always `"plan"`, so `stageFilePath("plan")` returns `"local://PLAN.md"` — identical behavior. For multi-stage, the first stage might be `"understand"`, giving `local://UNDERSTAND.md`. Deriving from `stages[0]` is more declarative and removes an ad-hoc override path.

### Why `sendReadOnlyContext` uses `deliverAs: "steer"`

The same pattern `sendPlanModeContext` uses. "Steer" injects the message mid-stream if the agent is currently streaming, so the model receives the context update immediately. A "followUp" would queue it for the next turn, potentially leaving the model operating under stale assumptions.

---

## Layer Breakdown

### Layer 1: Data (`plan-mode/state.ts`)
Pure types and pure functions. No I/O, no imports of tools or UI. This is where the stage model lives. Everything else imports from here.

### Layer 2: Tool guards (`tools/write-guard.ts`, `tools/bash.ts`)
These are the enforcement points. They check `session.getReadOnlyMode?.()` and `session.getPlanModeState?.()` via optional chaining — the session may not provide these methods (subagent sessions), in which case no restriction applies. The `?.()` pattern is intentional and correct: it means "enforce only when the session says to enforce."

### Layer 3: Tool contract (`tools/exit-plan-mode.ts`)
The exit tool bridges the agent's world (tool calls) and the UI's world (approval dialogs). It now carries `isIntermediate` and `currentStage` as routing hints. The tool doesn't know what happens next — it just tells the truth about where the session is.

### Layer 4: Session state (`session/agent-session.ts`)
Read-only state and context injection live here, parallel to plan mode state. `#readOnlyMode` is a simple boolean. `sendReadOnlyContext` follows the same pattern as `sendPlanModeContext`. The stage variables injected into `#buildPlanModeMessage` template data are the bridge between session state and prompt behavior.

### Layer 5: Interactive mode (`modes/interactive-mode.ts`)
All orchestration lives here. This is the largest change. The key structural decisions:
- `#resolveActiveStages()` snapshots the configured pipeline at mode entry
- `handleExitPlanModeTool` dispatches to two separate methods rather than branching inline
- `#advanceStage` is the single mutation point for stage progression: it updates state, updates the local mirror (`planModePlanFilePath`), updates the status line, and sends the new context
- All new private methods use `#` for encapsulation

### Layer 6: Settings + Prompts
Three new `planning.stages.*` boolean settings with UI metadata for the settings panel. The prompt template gets stage-aware sections appended — additive, backward compatible, gated by `{{#if isMultiStage}}`.

---

## What Broke During Implementation

### `hitRate` missing from test `SegmentContext`
`status-line-path.test.ts` had a hardcoded `usageStats` object missing `hitRate: null`. This was a pre-existing gap that became a type error when `SegmentContext.planMode` was extended (tsgo started reporting it). Added `hitRate: null` to the test.

### Biome format/import-organize errors in new files
Seven files needed import sorting and formatting fixes after the parallel agent batch. All were auto-fixed by `biome check --write`. This happens because subagents write code without running the formatter.

### `exit-plan-mode.test.ts` had three tests asserting the old contract
- Test asserted `title` was in `required[]` — now it's optional
- Error message for missing plan file changed from "Plan file not found... Write the finalized plan..." to "Stage file not found... Write the stage output..."
- Tests needed `isIntermediate` and `currentStage` assertion additions

---

## What We Should Improve Next Time

### 1. Run formatter as the last step of each parallel agent batch
Every agent batch ended with biome format errors. The fix was trivial (`biome check --write`) but required a separate step. The orchestration context should instruct agents to run `node_modules/.bin/biome check --write <files>` on the files they touched before reporting done.

### 2. The `plan-mode-guard.ts` shim should be deleted
The shim (`plan-mode-guard.ts` re-exporting from `write-guard.ts`) exists purely to avoid updating one caller: `exit-plan-mode.ts` imports `resolvePlanPath` from `plan-mode-guard`. The correct fix is to update that import to `write-guard` and delete the shim. The plan said "full CUTOVER," but the shim survived. A lie in the codebase — future readers will wonder why two files export the same thing.

### 3. `#criticReviewStage` stub is a named debt item, not a completed feature
The stub is documented as "Phase 4 will dispatch a real critic agent." But there's no issue, no ticket, no CHANGELOG entry marking this as deferred. Stubs without tracking become permanent. Before closing this feature, file an issue and add a `// TODO(#NNN):` comment.

### 4. Session restore path (`#restoreModeFromSession`) does not restore stage state
When a session is resumed, `planFilePath` is restored from `sessionContext.modeData`. But `stages`, `currentStageIndex`, and `completedStages` are not persisted to `sessionContext` and are not restored. A restored multi-stage session will behave as single-stage. This is a correctness gap worth fixing: either persist stage state to the session, or detect the missing state and fall back gracefully with a status message.

### 5. `/workflow config` in the workflow custom command uses `settings` singleton directly
`workflow/index.ts` imports `settings` (the process-level singleton) and calls `settings.set(key, value)`. This means the `config` subcommand in the workflow command couples the workflow module to the global settings instance. For consistency and testability, settings mutations should flow through `InteractiveModeContext` (which has access to the correct settings instance). The `/workflow config` command in `builtin-registry.ts` (`handleWorkflowConfigCommand`) already does this correctly; the duplicate path in `workflow/index.ts` is less clean.

### 6. The mutual-exclusivity error messages capitalize by hand
```typescript
const variant = this.session.getPlanModeState()?.autoMode ? "auto" : "plan";
this.showError(`${variant.charAt(0).toUpperCase() + variant.slice(1)} mode is...`);
```
This is inline string manipulation for a capitalization helper. The codebase should have a `capitalize(s)` utility. It doesn't. Not a bug, but noticeably ugly.

### 7. Stage restoration is not covered by tests
The session restore path (`#restoreModeFromSession`) is untested for multi-stage mode. The only tested contracts are: state helpers, write guard, and the exit-plan-mode tool. The interactive-mode approval flow (TUI approval, stage advancement, stage persistence) is not tested at all — the plan said these require mocking TUI components and were deferred to manual verification. A future improvement: add integration tests using the session's `streamFn` mock to drive the agent through stage transitions.

### 8. `#handleFinalStageApproval` only persists stages if `details.title` is present
The condition `if (state?.completedStages && details.title)` means single-stage mode (which always has a `completedStages: {}` but has an empty object) will never persist. This is intentional — nothing to persist for single-stage. But it also means a multi-stage session where the user somehow gets to final approval without a title will silently skip persistence. The logic should be: always persist if `completedStages` is non-empty, and the title check should be a separate concern.

### 9. `stageRetryCount` resets to 0 on advance but not on rejection resume
When a critic rejects a stage and the agent is set to retry, `stageRetryCount` is incremented via `setPlanModeState({ ...state, stageRetryCount: retries })`. But the session state spread (`...state`) includes the old `planFilePath`, so the model is re-steered to the same file path. This is correct behavior, but it's implicit — the spread makes it hard to see at a glance that `planFilePath` is intentionally unchanged on rejection.

### 10. The `#resolveWorkflowSlug` prompt only fires during final approval
If a user does a 4-stage run and the first 3 stages are named automatically based on the plan title (which isn't known until the final stage), there's no opportunity to name the workflow directory until the very end. This is probably fine — the slug is derived from the plan title, which is only known at the final stage — but it means the intermediate stage files have no stable location until approval.

---

## What Went Well

**Parallel agent dispatch for Phase 1+2** worked cleanly. Eight agents touched eight disjoint file sets with no conflicts. The total wall time was ~1m14s for all Phase 1+2 work.

**The plan's interface contracts were precise enough** that agents could write code calling functions (`isLastStage`, `enforceWriteGuard`, `session.getReadOnlyMode()`) that didn't exist yet in their view, and everything compiled after the merge.

**Backward compatibility was preserved throughout.** Optional chaining (`?.`), default values (`stages ?? ["plan"]`), and `isLastStage` returning `true` when no `stages` array means old sessions resume unchanged.

**The test suite caught the API contract breakage** in `exit-plan-mode.test.ts` immediately — the three failing tests were precise indicators of the contract change.

**Type-safe settings paths** — the `"planning.stages.*"` keys in `settings-schema.ts` are real `SettingPath` values, so `settings.get("planning.stages.understand")` is fully type-checked.
