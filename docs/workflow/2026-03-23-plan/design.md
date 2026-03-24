# Design: Workflow Config Redesign

## Prior Context

See `local://UNDERSTAND.md` for full requirements. Summary:
- Remove `/plan` and `/auto` slash commands
- Remove plan-mode sub-stages (understand/design/review/plan) — workflow phases replace them
- `/workflow config` opens TUI to configure per-phase settings (enabled, approval mode, review agent, max review rounds)
- Each setting independently configurable as global (persisted) or session (override)
- All phases write to `local://` first, persist to `docs/workflow/<slug>/` on approval
- Every phase writes learnings and updates relevant docs

---

## 1. Settings Schema

### New Settings (replace `planning.stages.*`)

Add settings under `workflow.phases.<phase>.*` for all 7 phases. Remove the three `planning.stages.*` settings.

```
Per phase (all 7):
  workflow.phases.<phase>.enabled        boolean   default: true
  workflow.phases.<phase>.approval       enum      values: ["none", "user", "agent", "both"]  default: "user"
  workflow.phases.<phase>.reviewAgent    enum      values: ["critic", "reviewer"]  default: "critic"
  workflow.phases.<phase>.maxReviewRounds enum     values: ["1", "2", "3", "4", "5"]  default: "3"
```

- **enabled**: Whether the phase runs at all.
- **approval**: Who must approve before the phase artifact is persisted and the next phase starts.
  - `none` = auto-advance, no approval needed
  - `user` = user must approve
  - `agent` = the configured review agent must approve
  - `both` = agent reviews first, then user confirms
- **reviewAgent**: Which agent performs the review when approval includes `agent`. Currently `critic` (adversarial plan reviewer) or `reviewer` (code review specialist).
- **maxReviewRounds**: The review -> fix -> review loop count. If the agent rejects maxReviewRounds times, escalates to user.

All use `tab: "workflow"` — a new tab added to `SETTING_TABS` and `SettingTab` type (replaces "tasks" usage for these).

All settings are boolean or enum types — no new schema type needed. `maxReviewRounds` is modeled as enum `["1", "2", "3", "4", "5"]` which cycles via Enter/Space in the SettingsList.

### Files to Modify
- `src/config/settings-schema.ts` — add `SettingTab = "workflow"`, add to `SETTING_TABS`, add all `workflow.phases.*` settings, remove `planning.stages.*`
- `src/modes/components/settings-defs.ts` — add tab metadata for "workflow" tab (icon, label)

---

## 2. `/workflow config` — TUI Component

### Approach: Dedicated `WorkflowConfigComponent`

Instead of reusing `SettingsSelectorComponent` (which is designed for the full settings panel with tabs), build a dedicated component specifically for workflow phase configuration. Reasons:
- The workflow config has a unique layout: 7 phase groups, each with 3-4 settings
- Need to show global vs session scope indicators per setting
- `SettingsSelectorComponent` has no concept of scope indicators

### Component Design

The panel has two modes toggled with `g`: **session scope** (default) and **global scope**.

**Session scope** — shows session overrides layered on top of global defaults. Editing here calls `settings.override()` (not persisted).

**Global scope** — shows and edits the persisted global defaults. Editing here calls `settings.set()` (saved to config.yml).

The active scope is displayed prominently in the header so it's always clear which you're editing.

```
┌─ Workflow Configuration [SESSION] ───────────────────┐
│                                                       │
│  ▸ brainstorm                                         │
│    Enabled:           ✓                               │
│    Approval:          user                            │
│    Review agent:       critic                         │
│    Max review rounds:  3                              │
│                                                       │
│  ▸ spec                                               │
│    Enabled:           ✓                               │
│    Approval:          none  *                         │
│    Review agent:       critic                         │
│    Max review rounds:  3                              │
│                                                       │
│  (* = overridden from global default)                 │
│                                                       │
│  [Enter] Toggle/Cycle  [g] Switch to Global  [r] Reset│
│  [Esc] Close                                          │
└───────────────────────────────────────────────────────┘
```

In session mode, a `*` marker next to a value indicates it differs from the global default. In global mode, no markers — you're editing the source of truth.

### Interaction Model

- **Arrow keys**: Navigate between settings across all phases (flat list with phase headers)
- **Enter/Space**: Cycle enum values or toggle booleans (writes to active scope)
- **`g`**: Toggle between session and global scope view
- **`r`**: Reset selected setting to global default (clears session override; only in session mode)
- **Escape**: Close panel

### Scope Mechanics

- In **session mode**: Enter/Space calls `settings.override(path, value)` — runtime only, lost on exit
- In **global mode**: Enter/Space calls `settings.set(path, value)` — persisted to config.yml
- `r` in session mode calls `settings.clearOverride(path)` — reverts to global default
- `settings.hasOverride(path)` determines whether to show `*` marker

### Implementation

New file: `src/extensibility/custom-commands/bundled/workflow/config-component.ts`

Uses existing TUI primitives:
- `Container` for vertical layout
- `Text` for phase headers and hint bar
- `SettingsList` for the actual settings within each phase group
- `Spacer` for visual separation
- `DynamicBorder` for top/bottom borders

The component is opened via `ctx.ui.custom()` from the workflow command's `config` case.

### Files to Create/Modify
- **Create**: `src/extensibility/custom-commands/bundled/workflow/config-component.ts`
- **Modify**: `src/extensibility/custom-commands/bundled/workflow/index.ts` — update `config` case to use new component
- **Modify**: `src/config/settings.ts` — add `hasOverride(path)` method

---

## 3. Remove `/plan` and `/auto` Commands

### Slash Command Removal

Remove from `src/slash-commands/builtin-registry.ts`:
- The `/plan` entry (name: "plan")
- The `/auto` entry (name: "auto")

Remove from `src/modes/types.ts`:
- `handlePlanModeCommand` method from `InteractiveModeContext` interface
- `handleAutoModeCommand` method from `InteractiveModeContext` interface

Remove from `src/modes/interactive-mode.ts`:
- `handlePlanModeCommand()` method
- `handleAutoModeCommand()` method

Remove keybinding:
- `src/config/keybindings.ts` — remove `togglePlanMode` from type, defaults, and array
- `src/modes/controllers/input-controller.ts` — remove Alt+Shift+P handler
- `src/modes/utils/hotkeys-markdown.ts` — remove plan mode row

### Files to Modify
- `src/slash-commands/builtin-registry.ts`
- `src/modes/interactive-mode.ts`
- `src/modes/types.ts`
- `src/config/keybindings.ts`
- `src/modes/controllers/input-controller.ts`
- `src/modes/utils/hotkeys-markdown.ts`

---

## 4. Remove Plan-Mode Sub-Stages

### Simplify `PlanModeState`

`src/plan-mode/state.ts` becomes:

```typescript
export interface PlanModeState {
    enabled: boolean;
    planFilePath: string;
    workflow?: "parallel" | "iterative";
    reentry?: boolean;
    workflowSlug?: string;
}
```

Removed fields: `PLAN_STAGES`, `PlanStage`, `stages`, `currentStageIndex`, `completedStages`, `stageRetryCount`, `stageFilePath()`, `isLastStage()`, `currentStage()`, **`autoMode`**.

**`autoMode` removal rationale**: The per-phase approval setting `none` replaces the concept of auto-mode at a finer granularity. `/auto` command is removed (Section 3), and nothing else sets `autoMode`. The `{{#if autoMode}}` conditional in `plan-mode-active.md` becomes dead code and is removed with the other multi-stage conditionals.

### Simplify `interactive-mode.ts`

Remove:
- `#resolveActiveStages()` — no longer needed
- `#advanceStage()` — no sub-stage advancement
- `#handleIntermediateStageApproval()` — all stages are "final" now
- `#criticReviewStage()` stub — replaced by workflow-level approval

Simplify `#enterPlanMode()`:
- Always single-stage: `planFilePath` is passed by caller
- No `stages` array computation

Simplify `handleExitPlanModeTool()`:
- No intermediate vs final distinction — always final
- Calls `#handleFinalStageApproval()` directly

### Simplify `plan-mode-active.md`

Remove all `{{#if isMultiStage}}` blocks, stage-specific conditionals (`{{#if (eq stageName ...)}}`), **and `{{#if autoMode}}`** blocks. Keep the core read-only instructions, plan file reference, and the iterative/non-iterative workflow choice.

### Remove Old Settings

Remove from `settings-schema.ts`:
- `planning.stages.understand`
- `planning.stages.design`
- `planning.stages.review`

### Files to Modify
- `src/plan-mode/state.ts`
- `src/modes/interactive-mode.ts`
- `src/prompts/system/plan-mode-active.md`
- `src/config/settings-schema.ts`
- `src/tools/exit-plan-mode.ts` (remove isIntermediate/currentStage handling)

---

## 5. Workflow Phase Lifecycle

### Phase Execution Flow

```
User runs /workflow brainstorm <topic>
  → new session created
  → plan mode entered (read-only for brainstorm/spec/design/plan phases)
  → agent writes to local://BRAINSTORM.md
  → agent calls exit_plan_mode
  → approval gate runs (based on workflow.phases.brainstorm.approval setting):
      none  → auto-persist, auto-advance
      user  → show approval selector to user
      agent → dispatch review agent, retry up to maxReviewRounds
      both  → agent reviews first, then user confirmation
  → on approval:
      1. persist local://BRAINSTORM.md to docs/workflow/<slug>/brainstorm.md
      2. agent writes learnings to docs/workflow/<slug>/learnings.md (appended)
      3. advance to next enabled phase
```

### Artifact Persistence

When a phase is approved (reviewer approved, or no reviewer active, AND user approved if required):
1. Read content from `local://<PHASE>.md`
2. Write to `docs/workflow/<slug>/<phase>.md` via `writeWorkflowArtifact()`
3. Append learnings to `docs/workflow/<slug>/learnings.md` (cumulative across phases)
4. Update `WorkflowState` in `docs/workflow/<slug>/state.json`
5. Advance to next enabled phase

**Key principle**: Nothing is persisted to `docs/workflow/<slug>/` until the approval gate passes. During the phase, all output lives in `local://` (ephemeral, in-session). This gives the reviewer and/or user a chance to reject or request changes before anything hits disk/git.

### Phase-Specific Behavior

**Planning phases** (brainstorm, spec, design, plan):
- Enter plan mode (read-only, tools restricted)
- Agent writes artifact to `local://<PHASE>.md`
- Agent calls `exit_plan_mode` to signal completion
- Approval gate runs
- On approval: artifact + learnings persisted to slug dir

**Execution phases** (execute, verify, finish):
- Do NOT enter plan mode — agent needs full tool access
- Agent does the actual work (implement code, run tests, finalize delivery)
- Agent writes learnings/findings/retrospective to `local://<PHASE>.md`
- Agent updates repo-wide documentation (see Documentation Updates below)
- Agent calls `exit_plan_mode` to signal completion (see below)
- Approval gate runs
- On approval: learnings persisted to slug dir

### Execution Phase Completion Signal

Execution phases reuse the `exit_plan_mode` tool, but it must work outside plan mode when a workflow phase is active. Changes needed:

1. **Relax the plan-mode guard in `exit-plan-mode.ts`**: Currently the tool checks `planMode.enabled` and refuses to run if not in plan mode. Add an alternative check: if `planMode.workflowSlug` is set (i.e., a workflow is active), the tool is allowed even when `planMode.enabled` is false.

2. **Content passed to approval gate**: For planning phases, the content is the `local://<PHASE>.md` artifact (the main output). For execution phases, the content is also `local://<PHASE>.md` — the learnings/retrospective file. The reviewer/critic reviews the learnings and any code changes made during the phase (via git diff or similar).

3. **Agent prompt for execution phases**: The execute/verify/finish prompt templates instruct the agent to:
   - Do the actual work (implement, test, finalize)
   - Update repo-wide documentation as part of the work
   - Write learnings/retrospective to `local://<PHASE>.md`
   - Call `exit_plan_mode` with the title when done

This avoids introducing a new tool. The tool name is slightly misleading for non-plan phases, but the alternative (renaming to `complete_phase` everywhere) touches more surface area for no behavioral gain. The `title` parameter already serves as the phase completion signal.

### Learnings and Retrospective

Learnings follow the artifact lifecycle: `local://` during the phase, `docs/workflow/<slug>/` after approval.

Each phase writes to `local://<PHASE>.md` a section covering:
1. **Findings** — key discoveries, decisions made, tradeoffs encountered
2. **What went well** — approaches that worked, tools that helped
3. **What to improve** — pain points, things that took longer than expected
4. **Recommendations** — concrete suggestions for next time

On approval, this content is persisted to `docs/workflow/<slug>/<phase>.md`. The cumulative learnings across all phases become a project record — version-controlled, searchable, and available for future workflows on the same codebase.

### Documentation Updates

Execution phases (execute, verify, finish) write **repo-wide documentation** to `docs/` — not slug-specific. This follows standard software development practices:

- **execute**: Update architecture docs (`docs/architecture/`), API documentation, ADRs (Architecture Decision Records), inline code comments, module-level READMEs
- **verify**: Update test documentation, test plans, coverage notes, QA runbooks
- **finish**: Update project CHANGELOG, top-level README, deployment docs, release notes

Planning phases update documentation relevant to their scope:
- **brainstorm**: Create or update design exploration docs, feasibility notes
- **spec**: Write/update requirements documents, acceptance criteria
- **design**: Write/update architecture docs, component diagrams, interface specifications
- **plan**: The plan IS the documentation (task breakdown, implementation order)

The prompt templates for each phase include explicit instructions about which docs to create or update. This ensures every workflow produces lasting project documentation, not just ephemeral artifacts.

### Files to Modify
- `src/extensibility/custom-commands/bundled/workflow/index.ts` — phase transition logic, approval gate
- `src/extensibility/custom-commands/bundled/workflow/artifacts.ts` — `WorkflowState` gets `activePhases` field, learnings persistence
- `src/extensibility/custom-commands/bundled/workflow/prompts/*.md` — all 7 prompts updated (local://, learnings, repo-wide docs)
- `src/modes/interactive-mode.ts` — simplified `handleExitPlanModeTool`, approval flow
- `src/tools/exit-plan-mode.ts` — relax plan-mode guard for workflow phases

---

## 6. Approval Gate Implementation

### Where It Lives

New file: `src/extensibility/custom-commands/bundled/workflow/approval.ts`

### Logic

```typescript
type ApprovalMode = "none" | "user" | "agent" | "both";
type ReviewAgent = "critic" | "reviewer";

async function runApprovalGate(
    phase: WorkflowPhase,
    content: string,
    ctx: HookCommandContext,
): Promise<{ approved: boolean; feedback?: string }> {
    const approval = getPhaseApproval(phase);       // reads workflow.phases.<phase>.approval
    const agentType = getPhaseReviewAgent(phase);    // reads workflow.phases.<phase>.reviewAgent
    const maxRounds = getPhaseMaxReviewRounds(phase); // reads workflow.phases.<phase>.maxReviewRounds

    if (approval === "none") return { approved: true };

    if (approval === "agent" || approval === "both") {
        const result = await runAgentReview(content, phase, agentType, maxRounds, ctx);
        if (!result.approved) return result;
    }

    if (approval === "user" || approval === "both") {
        const userResult = await promptUserApproval(ctx);
        if (!userResult.approved) return userResult;
    }

    return { approved: true };
}
```

### Review Agent Dispatch

The `runAgentReview` function:
- Reads `reviewAgent` setting to determine which agent to dispatch (critic or reviewer)
- Both agents are bundled (`src/prompts/agents/critic.md`, `src/prompts/agents/reviewer.md`)
- Spawned via the task/agent infrastructure with the phase content as context
- Runs a review -> fix -> review loop up to `maxReviewRounds` times
- If agent rejects after max rounds: escalates to user approval
- If agent approves: returns `{ approved: true }`

### Persistence Trigger

The approval gate is the gatekeeper for persistence. Only after `runApprovalGate` returns `{ approved: true }` does the workflow engine:
1. Persist the phase artifact from `local://` to `docs/workflow/<slug>/`
2. Persist learnings
3. Advance to the next phase

If the gate rejects (user or agent), the agent is given feedback and can revise the artifact in `local://`. Nothing touches disk until approval.

### Files to Create/Modify
- **Create**: `src/extensibility/custom-commands/bundled/workflow/approval.ts`
- **Modify**: `src/modes/interactive-mode.ts` — wire approval gate into exit flow

---

## 7. `settings.hasOverride()` Method

Add to `src/config/settings.ts`:

```typescript
hasOverride(path: SettingPath): boolean {
    const segments = parsePath(path);
    let current = this.#overrides;
    for (const segment of segments) {
        if (!(segment in current)) return false;
        current = current[segment] as RawSettings;
    }
    return true;
}
```

This lets the config component show `*` marker in session mode for overridden values.

### Files to Modify
- `src/config/settings.ts`

---

## 8. Critic Review Fixes

Two issues identified by critic review and resolved in this revision:

### Fix 1: Remove `autoMode` from PlanModeState

**Problem**: `autoMode` was retained in simplified PlanModeState but `/auto` command is removed, leaving nothing to set it. The per-phase approval setting `none` replaces auto-mode at finer granularity.

**Resolution**: Removed `autoMode` from PlanModeState interface (Section 4). Added `{{#if autoMode}}` to the list of conditionals removed from `plan-mode-active.md`.

### Fix 2: Execution phase completion signal

**Problem**: Design stated execution phases need "a completion signal (new tool or command)" without specifying what.

**Resolution**: Reuse `exit_plan_mode` tool by relaxing its guard — allow it when `workflowSlug` is set, even outside plan mode (Section 5). Content for approval gate is the `local://<PHASE>.md` learnings file. Avoids new tool creation.

---

## Summary: All Files Changed

### New Files
- `src/extensibility/custom-commands/bundled/workflow/config-component.ts` — workflow config TUI
- `src/extensibility/custom-commands/bundled/workflow/approval.ts` — approval gate logic

### Modified Files (by area)

**Settings schema**:
- `src/config/settings-schema.ts` — add `workflow` tab, add `workflow.phases.*` settings, remove `planning.stages.*`
- `src/config/settings.ts` — add `hasOverride()` method
- `src/modes/components/settings-defs.ts` — add workflow tab metadata

**Workflow command**:
- `src/extensibility/custom-commands/bundled/workflow/index.ts` — config subcommand, phase transitions, approval
- `src/extensibility/custom-commands/bundled/workflow/artifacts.ts` — WorkflowState update, learnings persistence
- `src/extensibility/custom-commands/bundled/workflow/prompts/*.md` — all 7 prompts (local://, learnings, repo-wide docs)

**Plan mode simplification**:
- `src/plan-mode/state.ts` — remove sub-stages and autoMode, simplify PlanModeState
- `src/modes/interactive-mode.ts` — remove sub-stage logic, simplify exit flow
- `src/prompts/system/plan-mode-active.md` — remove multi-stage and autoMode conditionals
- `src/tools/exit-plan-mode.ts` — remove intermediate stage handling, relax guard for workflow phases

**Command removal**:
- `src/slash-commands/builtin-registry.ts` — remove /plan, /auto
- `src/modes/types.ts` — remove handler interfaces
- `src/config/keybindings.ts` — remove togglePlanMode
- `src/modes/controllers/input-controller.ts` — remove keybinding handler
- `src/modes/utils/hotkeys-markdown.ts` — remove help text

---

## Verification

1. `bun check:ts` passes (no type errors)
2. `/workflow config` opens TUI with all 7 phases and their settings
3. `g` toggles between session and global scope views
4. In session mode, `*` marker shows on settings that differ from global default
5. In global mode, edits persist to config.yml
6. `r` in session mode resets a setting to its global default
7. `/plan` and `/auto` commands no longer appear in autocomplete
8. Alt+Shift+P keybinding is gone
9. `/workflow brainstorm <topic>` enters plan mode, agent writes to `local://BRAINSTORM.md`
10. On approval, artifact is persisted to `docs/workflow/<slug>/brainstorm.md`
11. Learnings only persist to `docs/workflow/<slug>/` after approval — not before
12. Phase with approval=none auto-advances without user interaction
13. Agent approval dispatches configured review agent and respects maxReviewRounds
14. Execution phases (execute, verify, finish) can call `exit_plan_mode` without being in plan mode
15. Execution phases write repo-wide docs to `docs/` (architecture, ADRs, test docs, CHANGELOG)
16. `autoMode` no longer exists in PlanModeState or plan-mode-active.md
