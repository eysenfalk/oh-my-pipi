# Implementation Plan: Workflow Config Redesign

## Context

Full design in `local://DESIGN.md`. This plan is the ordered implementation task list.

All paths relative to `packages/coding-agent/`.

## Prior Code Changes (from earlier session)

These changes exist in the working tree and must be preserved:
- `src/prompts/prompt-templates.ts` — `eq` Handlebars helper added after `not` helper
- `src/modes/components/settings-selector.ts` — `initialTab` parameter added to constructor
- `src/extensibility/custom-commands/bundled/workflow/index.ts` — `config` case updated to use `ctx.ui.custom()` with SettingsSelectorComponent (will be replaced by new component in this plan)

---

## Phase 1: Foundation (5 tasks, all parallel)

### Task 1A: Settings Schema
**Agent**: mid_task
**Files**: `src/config/settings-schema.ts`, `src/modes/components/settings-defs.ts`
**Changes**:
1. Add `"workflow"` to `SettingTab` union type (after `"tasks"`)
2. Add `"workflow"` to `SETTING_TABS` array
3. Add `workflow: { label: "Workflow", icon: "tab.workflow" }` to `TAB_METADATA`
4. Add 28 new settings (4 per phase x 7 phases) under `workflow.phases.<phase>.*`:
   - `workflow.phases.brainstorm.enabled` — boolean, default true, tab "workflow"
   - `workflow.phases.brainstorm.approval` — enum ["none","user","agent","both"], default "user", tab "workflow"
   - `workflow.phases.brainstorm.reviewAgent` — enum ["critic","reviewer"], default "critic", tab "workflow"
   - `workflow.phases.brainstorm.maxReviewRounds` — enum ["1","2","3","4","5"], default "3", tab "workflow"
   - (repeat for spec, design, plan, execute, verify, finish)
5. Remove `planning.stages.understand`, `planning.stages.design`, `planning.stages.review` settings (~lines 1602-1618)
6. In `settings-defs.ts`: no changes needed (TAB_METADATA in schema file already covers it)
**Verify**: `bun check:ts` on this file

### Task 1B: settings.hasOverride()
**Agent**: quick_task
**Files**: `src/config/settings.ts`
**Changes**:
1. Add `hasOverride(path: SettingPath): boolean` method to Settings class
2. Implementation: parse path into segments, walk `this.#overrides` tree, return true if leaf exists
**Verify**: method compiles

### Task 1C: Remove /plan and /auto Commands
**Agent**: mid_task
**Files**: `src/slash-commands/builtin-registry.ts`, `src/modes/types.ts`, `src/config/keybindings.ts`, `src/modes/controllers/input-controller.ts`, `src/modes/utils/hotkeys-markdown.ts`
**Changes**:
1. `builtin-registry.ts`: Remove the `/plan` entry (lines ~83-91) and `/auto` entry (lines ~93-101)
2. `types.ts`: Remove `handlePlanModeCommand(initialPrompt?: string): Promise<void>` and `handleAutoModeCommand(initialPrompt?: string): Promise<void>` from `InteractiveModeContext` interface (lines ~219-220)
3. `keybindings.ts`: Remove `togglePlanMode` from `AppAction` type (line ~25), from `DEFAULT_APP_KEYBINDINGS` (line ~65), and from `APP_ACTIONS` array (line ~99)
4. `input-controller.ts`: Remove the Alt+Shift+P handler block (lines ~124-126)
5. `hotkeys-markdown.ts`: Remove the plan mode row (line ~45)
**Note**: Do NOT touch `interactive-mode.ts` yet — Task 2A handles that file

### Task 1D: Simplify plan-mode/state.ts
**Agent**: quick_task
**Files**: `src/plan-mode/state.ts`
**Changes**:
1. Remove `PLAN_STAGES` constant and `PlanStage` type
2. Remove from `PlanModeState`: `autoMode`, `stages`, `currentStageIndex`, `completedStages`, `stageRetryCount`
3. Remove helper functions: `stageFilePath()`, `isLastStage()`, `currentStage()`
4. Resulting interface: `{ enabled, planFilePath, workflow?, reentry?, workflowSlug? }`

### Task 1E: Simplify plan-mode-active.md
**Agent**: quick_task
**Files**: `src/prompts/system/plan-mode-active.md`
**Changes**:
1. Remove `{{#if autoMode}}...{{/if}}` block (~lines 63-67)
2. Remove `{{#if isMultiStage}}...{{/if}}` block and all stage-specific conditionals (`{{#if (eq stageName "understand")}}` etc.) (~lines 76-111)
3. Keep: plan-mode read-only instructions, plan file reference (`{{planFilePath}}`), `{{#if planExists}}`, iterative/non-iterative workflow choice, and the procedure/phase/caution/directives/critical sections

---

## Phase 2: Simplify Interactive Mode + Exit Tool (sequential after Phase 1)

### Task 2A: Simplify interactive-mode.ts
**Agent**: senior_task
**Files**: `src/modes/interactive-mode.ts`
**Changes**:
1. Remove `handlePlanModeCommand()` method (~line 806-828)
2. Remove `handleAutoModeCommand()` method (~line 830-852)
3. Remove `#resolveActiveStages()` method (~line 880)
4. Remove `#advanceStage()` method (~line 889)
5. Remove `#handleIntermediateStageApproval()` method (~line 914)
6. Remove `#criticReviewStage()` stub method
7. Simplify `#enterPlanMode()`: remove stages array computation, always single-stage
8. Simplify `handleExitPlanModeTool()`: remove intermediate vs final distinction, always call `#handleFinalStageApproval()` directly
9. Remove any imports of `PLAN_STAGES`, `PlanStage`, `stageFilePath`, `isLastStage`, `currentStage` from state.ts
**Note**: This is the most complex task — touches many methods in a large file. Read each method body before editing.

### Task 2B: Simplify exit-plan-mode.ts
**Agent**: mid_task
**Files**: `src/tools/exit-plan-mode.ts`
**Changes**:
1. Remove the `intermediate` branch (lines ~76-86): no more `isIntermediate`, `currentStage` in details
2. Relax the plan-mode guard (line ~56-58): allow the tool when `state?.workflowSlug` is set, even if `!state?.enabled`
   - New guard: `if (!state?.enabled && !state?.workflowSlug) throw new ToolError("Plan mode is not active.")`
3. Remove imports of `currentStage`, `isLastStage` from state.ts

---

## Phase 3: New Components (parallel, after Phase 1)

### Task 3A: WorkflowConfigComponent
**Agent**: senior_task
**Files**: `src/extensibility/custom-commands/bundled/workflow/config-component.ts` (NEW)
**Changes**:
1. Create dedicated TUI component for `/workflow config`
2. Build flat list of all 7 phases x 4 settings = 28 items with phase headers
3. Two scope modes: session (default) and global, toggled with `g`
4. Session mode: `*` marker on overridden values, edits call `settings.override()`
5. Global mode: edits call `settings.set()`, no markers
6. `r` key: reset selected setting in session mode (`settings.clearOverride()`)
7. Arrow keys navigate, Enter/Space cycles values, Escape closes
8. Use existing TUI primitives: Container, Text, SettingsList, Spacer, DynamicBorder
9. Export a factory function compatible with `ctx.ui.custom()`
**Reference**: Study `src/modes/components/settings-selector.ts` and `SettingsList` for patterns

### Task 3B: Approval Gate
**Agent**: senior_task
**Files**: `src/extensibility/custom-commands/bundled/workflow/approval.ts` (NEW)
**Changes**:
1. Export `runApprovalGate(phase, content, ctx)` function
2. Read per-phase settings: `workflow.phases.<phase>.approval`, `.reviewAgent`, `.maxReviewRounds`
3. Dispatch logic: none → auto-approve, agent → run agent review, user → prompt user, both → agent then user
4. `runAgentReview`: dispatch critic or reviewer agent via task infrastructure, review→fix→review loop up to maxReviewRounds, escalate to user on max
5. `promptUserApproval`: use existing approval selector pattern from interactive-mode
6. Export types: `ApprovalMode`, `ReviewAgent`
**Reference**: Study `src/task/agents.ts` and `src/prompts/agents/critic.md` for agent dispatch patterns

---

## Phase 4: Wire Workflow (sequential after Phase 3)

### Task 4A: Update workflow/index.ts
**Agent**: senior_task
**Files**: `src/extensibility/custom-commands/bundled/workflow/index.ts`
**Changes**:
1. Update `config` case: instantiate `WorkflowConfigComponent` instead of `SettingsSelectorComponent`
2. Update `#getNextPhase()`: skip disabled phases (read `workflow.phases.<phase>.enabled` setting)
3. Wire approval gate into phase transitions: after `exit_plan_mode`, call `runApprovalGate()`
4. On approval: persist artifact from `local://` to `docs/workflow/<slug>/`, persist learnings
5. Execution phases: don't enter plan mode, but do set `workflowSlug` in state
6. Phase prompt rendering: pass `workflowSlug` and phase config to templates

### Task 4B: Update workflow/artifacts.ts
**Agent**: mid_task
**Files**: `src/extensibility/custom-commands/bundled/workflow/artifacts.ts`
**Changes**:
1. Add `activePhases` to `WorkflowState` (filtered list of enabled phases)
2. Add `persistPhaseLearnings(slug, phase, content)` function — appends to `docs/workflow/<slug>/learnings.md`
3. Ensure `writeWorkflowArtifact` works with the new `local://` → `docs/` flow

---

## Phase 5: Prompt Templates (parallel after Phase 4)

### Task 5A: Update All 7 Prompt Templates
**Agent**: mid_task
**Files**: All files in `src/extensibility/custom-commands/bundled/workflow/prompts/`
- `brainstorm-start.md`
- `spec-start.md`
- `design-start.md`
- `plan-start.md`
- `execute-start.md`
- `verify-start.md`
- `finish-start.md`

**Changes per template**:
1. Instruct agent to write output to `local://<PHASE>.md` (not directly to `docs/workflow/<slug>/`)
2. Include learnings/retrospective section instructions (findings, what went well, what to improve, recommendations)
3. Planning phases: include doc update instructions for their scope
4. Execution phases: include repo-wide documentation instructions following software dev standards:
   - execute: architecture docs, ADRs, API docs, inline comments
   - verify: test docs, test plans, coverage notes, QA runbooks
   - finish: CHANGELOG, README, deployment docs, release notes
5. All phases: instruct agent to call `exit_plan_mode` when done

---

## Phase 6: Verify

### Task 6A: Type Check
**Command**: `bun check:ts`
**Expected**: No type errors

### Task 6B: Manual Verification Checklist
1. `/workflow config` opens TUI with 7 phases, 4 settings each
2. `g` toggles global/session, `*` shows overrides
3. `/plan` and `/auto` no longer exist as commands
4. Alt+Shift+P does nothing
5. Workflow phases respect enabled setting
6. Approval gate dispatches correct agent

---

## Dependency Graph

```
Phase 1 (parallel): 1A, 1B, 1C, 1D, 1E
    ↓
Phase 2 (sequential): 2A → 2B
    ↓
Phase 3 (parallel): 3A, 3B    (also depends on 1A, 1B)
    ↓
Phase 4 (sequential): 4A → 4B
    ↓
Phase 5 (parallel): 5A
    ↓
Phase 6: verify
```

## Agent Tier Selection Rationale

- **senior_task**: interactive-mode.ts (large file, many interdependent methods), WorkflowConfigComponent (new TUI component, complex state), approval gate (new subsystem, agent dispatch)
- **mid_task**: settings schema (mechanical but many entries), command removal (5 files, straightforward), exit-plan-mode.ts (moderate complexity), artifacts.ts, prompt templates
- **quick_task**: hasOverride (one method), state.ts (delete code), plan-mode-active.md (delete blocks)
