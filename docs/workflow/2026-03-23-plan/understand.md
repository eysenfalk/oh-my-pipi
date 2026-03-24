# Understanding: Workflow Config Redesign

## User Request (Clarified)

1. **Remove `/plan` and `/auto` slash commands** — just the command registrations, not all plan mode infrastructure
2. **Remove plan-mode sub-stages entirely** — the current understand → design → review → plan sub-stages within plan mode are redundant. The workflow phases themselves cover those responsibilities:
   - brainstorm = explore idea, ask questions, understand the problem space
   - spec = write formal requirements
   - design = write architecture/design doc
   - plan = write implementation tasks (single-stage, no sub-stages)
   - execute/verify/finish = implementation and delivery
3. **`/workflow config` configures workflow phases** — which of the 7 phases are active, plus per-phase settings
4. **Per-phase settings** (all 7 phases):
   - **Enabled** — whether the phase runs at all
   - **Approval mode** — who must approve the phase output before it’s persisted and the next phase starts. One of:
     - `none` — phase completes automatically, no approval needed
     - `user` — user must approve
     - `critic` — critic/reviewer agent must approve
     - `both` — both user AND critic/reviewer must approve
   - **Max critic rounds** — maximum critic iterations before escalating to user (default 3)
   - **Reviewer enabled** — (execute, verify, finish only) whether reviewer agent reviews code changes
5. **Each per-phase setting is independently configurable as global (persisted) or session-only (override)**
   - The TUI must show which scope a value comes from and let the user set at either scope
6. **All phases write to `local://`** — each phase writes its output to `local://<PHASE>.md` (e.g., `local://BRAINSTORM.md`, `local://SPEC.md`, `local://DESIGN.md`, `local://PLAN.md`). On plan approval, all phase artifacts get copied to `docs/workflow/<slug>/` for permanent git-versioned storage.
7. **Every phase writes learnings** — after being approved (or after reviewer/critic approval), every phase — including execute, verify, and finish — must document what went well and what to do better next time. This is a retrospective output baked into the phase completion flow.
8. **Every phase updates relevant documentation** — each phase must update its fitting project documentation as part of its work (e.g., design updates architecture docs, execute updates code-level docs, finish updates changelogs/READMEs).

## What Gets Removed

### Slash commands to delete
- `/plan` registration in `src/slash-commands/builtin-registry.ts` (lines 83-92)
- `/auto` registration in `src/slash-commands/builtin-registry.ts` (lines 93-102)
- `handlePlanModeCommand()` in `src/modes/interactive-mode.ts` (line 807)
- `handleAutoModeCommand()` in `src/modes/interactive-mode.ts` (line 831)
- `handlePlanModeCommand` / `handleAutoModeCommand` in `src/modes/types.ts` (line 220-221)
- Alt+Shift+P keybinding in `src/modes/controllers/input-controller.ts` (line 124-126)
- `togglePlanMode` in `src/config/keybindings.ts` (lines 25, 65, 99)
- Hotkey help text in `src/modes/utils/hotkeys-markdown.ts` (line 45)

### Plan-mode sub-stages to delete
- `PLAN_STAGES` constant and `PlanStage` type in `src/plan-mode/state.ts`
- `stages`, `currentStageIndex`, `completedStages`, `stageRetryCount` fields from `PlanModeState`
- `stageFilePath()`, `isLastStage()`, `currentStage()` helpers in `src/plan-mode/state.ts`
- `#resolveActiveStages()` in interactive-mode.ts (line 880)
- `#advanceStage()` in interactive-mode.ts (line 889)
- `#handleIntermediateStageApproval()` in interactive-mode.ts (line 914)
- Stage-specific conditionals in `plan-mode-active.md` (`{{#if isMultiStage}}`, `{{#if (eq stageName ...)}}`)
- `planning.stages.understand`, `planning.stages.design`, `planning.stages.review` settings in `settings-schema.ts`

### What stays (plan mode infrastructure still needed by workflow)
- `#enterPlanMode()` / `#exitPlanMode()` — workflow phases use plan mode for read-only phases
- `ExitPlanModeTool` in `src/tools/exit-plan-mode.ts` — agent calls this to complete a phase
- `handleExitPlanModeTool()` / `#handleFinalStageApproval()` — approval flow
- `plan-mode-guard.ts` — blocks write tools in read-only planning phases
- `plan-mode-active.md` — simplified: no sub-stages, no multi-stage conditionals
- `PlanModeState` — simplified: just `enabled`, `planFilePath`, `autoMode`, `workflowSlug`

## Current Architecture

### Workflow Command (`/workflow`)
- **Files**:
  - `src/extensibility/custom-commands/bundled/workflow/index.ts` — `WorkflowCommand` class
  - `src/extensibility/custom-commands/bundled/workflow/artifacts.ts` — `WorkflowState`, persistence, slug generation
  - `src/extensibility/custom-commands/bundled/workflow/prompts/*.md` — 7 phase prompt templates
- **Phases**: `["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"]` (hardcoded in `#getNextPhase`)
- **Behavior**: Each phase creates a new session via `ctx.newSession()`, renders Handlebars prompt. Artifacts saved to `docs/workflow/<slug>/`.
- **Config subcommand**: Currently opens `SettingsSelectorComponent` on "tasks" tab — wrong target, configures plan-mode sub-stages instead of workflow phases.

### Artifact Flow (current vs desired)
- **Current**: Each workflow phase creates a new session. The brainstorm/spec/design/plan phases tell the agent to write to `{{workflowDir}}/brainstorm.md` (on-disk immediately). Plan-mode sub-stages write to `local://UNDERSTAND.md` etc. and copy to `docs/workflow/<slug>/` on approval via `#persistStagesToDocs`.
- **Desired**: All phases write to `local://<PHASE>.md` first (ephemeral, in-session). On approval (user or critic/reviewer), artifacts get persisted to `docs/workflow/<slug>/`. This gives the user a chance to review before anything hits disk/git.

### Settings System
- **File**: `src/config/settings.ts` — `Settings` singleton
- **Persistence**: `~/.omp/agent/config.yml` (YAML)
- **Layers**: `#global` (persisted) → `#project` (from `.omp/`) → `#overrides` (runtime, not persisted)
- **Session-scoped API**: `settings.override(path, value)` — runtime-only, `settings.clearOverride(path)`
- **Global API**: `settings.set(path, value)` — persisted to config.yml
- **Schema**: `src/config/settings-schema.ts` — typed definitions with UI metadata
- **UI**: `SettingsSelectorComponent` — tabbed settings panel with `initialTab` parameter

### Critic / Reviewer Agent Infrastructure
- **Critic agent** (`src/prompts/agents/critic.md`): Adversarial plan reviewer. Output: verdict (approved/needs_revision) + issues array.
- **Reviewer agent** (`src/prompts/agents/reviewer.md`): Code review specialist. Output: overall_correctness + findings.
- **Agent dispatch**: `src/task/agents.ts` — registry. `src/task/discovery.ts` — discovery.
- **Critic stub**: `#criticReviewStage()` in interactive-mode.ts always returns `true`. Needs real implementation.

### TUI Component System
- **SettingsList items**: `{ id, label, currentValue, description?, values?, submenu? }` — `values` enables cycling
- **Grouping**: Text headers + Spacer (no native sections)
- **Custom component**: `ctx.ui.custom(factory)` → factory gets `(tui, theme, done)` → returns Component

## Resolved Questions

1. **`/plan` and `/auto`**: Both slash commands removed. Plan mode infrastructure stays for workflow to use internally.
2. **Plan-mode sub-stages**: Completely removed. The workflow phases themselves replace them. Plan mode becomes single-stage only.
3. **All 7 phases configurable**: Each phase gets enabled, approval mode (none/user/critic/both), maxCriticRounds. execute/verify/finish additionally get a reviewer toggle.
4. **Approval mode replaces auto+critic toggles**: Single enum per phase controls the approval gate. `none` = auto-advance. `critic` = critic agent must approve. `user` = user approves. `both` = critic first, then user confirms. Each independently settable as global or session override.
5. **Artifact lifecycle**: Phases write to `local://` first. On approval, copied to `docs/workflow/<slug>/`. This matches the plan-mode sub-stage pattern the user likes.
6. **Learnings**: Every phase writes a retrospective section after approval. This includes execute/verify/finish — not just the planning phases.
7. **Documentation updates**: Each phase is responsible for updating relevant project docs as part of its work.

## Constraints

- Prompts live in `.md` files with Handlebars — no inline string building
- No `console.log` — use logger
- `settings.override()` exists for session-scoped values (not persisted)
- `settings.set()` persists to global config.yml
- `SettingsSelectorComponent` can be extended or a new dedicated component built
- The workflow command has `ctx.ui.custom()` integration
- TUI sections built with Text headers + Spacer (no native grouping)
- Agent types (critic, reviewer) already exist as bundled agents with defined prompts
- `eq` Handlebars helper was added in prior session (prompt-templates.ts)
