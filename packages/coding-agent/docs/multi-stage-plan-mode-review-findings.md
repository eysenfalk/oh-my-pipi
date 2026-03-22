# Review Findings: Multi-Stage Plan Mode + Read-Only Toggle

Reviewed by: automated reviewer agents (ReviewCore, ReviewSession, ReviewInteractiveMode)

---

## CRITICAL / P2 Bugs (5)

### [BUG-1] `currentStage()` returns `undefined` for empty `stages` array, violating return type
**File**: `src/plan-mode/state.ts:28-30`

`currentStage()` uses `state.stages ?? ["plan"]` — the `??` catches `null`/`undefined` but not an empty array `[]`. When `stages` is `[]`, `stages[0]` is `undefined`, returned as `PlanStage`. The downstream consumer at `interactive-mode.ts:935` calls `details.currentStage.charAt(0)` which crashes with `TypeError: Cannot read properties of undefined`.

`isLastStage` already handles empty arrays: `if (!stages || stages.length === 0) return true`. The two helpers are inconsistent.

**Fix**: `const stages = state.stages?.length ? state.stages : ["plan"];`

---

### [BUG-2] Stale read-only context persists after toggling off — model still believes writes are forbidden
**File**: `src/session/agent-session.ts:2130-2140`, `src/modes/interactive-mode.ts:1013-1017`

When `/read-only` is enabled, `sendReadOnlyContext({ deliverAs: "steer" })` injects the directive "You MUST NOT modify the system" into the model's conversation history. When `/read-only` is toggled off, only `setReadOnlyMode(false)` is called — no message is sent to retract the directive.

The tool-level guards correctly allow writes, but the model still sees the read-only instruction in its context and will self-censor on write attempts. The user has to manually tell the model that it can now write.

Unlike plan mode (which clears the session on approval), read-only mode has no session clear — the stale context persists for the remainder of the session.

**Fix**: Send a "read-only disabled" context message when toggling off, parallel to the enable path.

---

### [BUG-3] Single-stage plan mode now prompts every user for a workflow slug — UX regression
**File**: `src/modes/interactive-mode.ts:958-963`

In `#handleFinalStageApproval`, the condition:
```typescript
if (state?.completedStages && details.title)
```
`completedStages` is initialized to `{}` in `#enterPlanMode` and `{}` is truthy in JavaScript. `details.title` is always present for the final stage. This means ALL plan-mode sessions — including single-stage (default) — now trigger `#resolveWorkflowSlug`, prompting the user to name a workflow directory. Then `#persistStagesToDocs` runs with `{ plan: planContent }` — just the plan file.

Old behavior: single-stage mode went directly to `#approvePlan`. This is a behavior regression for the majority of users.

**Fix**: `if (state?.completedStages && Object.keys(state.completedStages).length > 0 && details.title)`

---

### [BUG-4] Session restore creates incoherent multi-stage state: wrong stage index for restored path
**File**: `src/modes/interactive-mode.ts:662-672`

When `#restoreModeFromSession` calls `#enterPlanMode({ planFilePath: "local://DESIGN.md" })`, `#enterPlanMode` freshly computes stages from current settings (e.g. `["understand", "design", "plan"]`) and hardcodes `currentStageIndex: 0`.

This produces: `currentStage(state)` returns `"understand"` (index 0) but `planFilePath` is `"local://DESIGN.md"`. The plan-mode context template instructs the model: "You are working on the **understand** stage. Write your output to `local://DESIGN.md`." — a direct contradiction.

All completed intermediate stages are also lost (`completedStages: {}`).

**Fix**: When `options?.planFilePath` is explicitly provided (restore path), treat the session as single-stage: `const stages = options?.planFilePath ? (["plan"] as PlanStage[]) : this.#resolveActiveStages();`

---

## MINOR / P3 Issues (1)

### [P3] Dead template variable `currentStageName` duplicates `stageName`
**File**: `src/session/agent-session.ts:2277-2279`

`#buildPlanModeMessage` passes both `currentStageName: currentStage(state)` and `stageName: currentStage(state)` to `renderPromptTemplate`. Both have identical values. `plan-mode-active.md` only references `{{stageName}}`. `currentStageName` is never referenced in any template.

**Fix**: Remove `currentStageName` from the template vars object.

---

## Summary

| ID | Severity | Description | Status |
|---|---|---|---|
| BUG-1 | P2 | `currentStage()` undefined for empty stages | Fixed |
| BUG-2 | P2 | Stale read-only context after toggle-off | Fixed |
| BUG-3 | P2 | Single-stage UX regression: slug prompt fires always | Fixed |
| BUG-4 | P2 | Session restore: incoherent stage/path state | Fixed |
| P3-1 | P3 | Dead `currentStageName` template variable | Fixed |

All 5 issues were fixed in the same session.
