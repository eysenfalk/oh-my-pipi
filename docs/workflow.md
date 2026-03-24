# Workflow

A structured multi-phase development process for complex features that span multiple sessions.

## Overview

The workflow system guides a feature from raw idea through formal specification, architectural design, implementation planning, execution, verification, and release. Each phase produces a persisted artifact that subsequent phases consume. Phases are gated: later phases cannot start until their prerequisites are complete.

**Use workflow when:**
- The feature requires more than one session to implement
- You need to explore the problem space before writing code
- The change warrants a written specification, design document, or implementation plan
- Multiple agents or reviewers need to sign off at phase boundaries

**Do not use workflow for:**
- Bug fixes with a known, localized cause
- Small changes that fit in a single session
- Exploratory spikes with no expected deliverable

---

## Quick Start

```
# Start a new workflow
/workflow brainstorm auth-refactor

# (Agent runs brainstorm, calls exit_plan_mode when done, approval gate fires)
# (Artifact saved to docs/workflow/2026-03-24-auth-refactor/brainstorm.md)

# Move to specification
/workflow spec

# Move to design
/workflow design

# Skip a phase if not needed
/workflow skip plan

# Jump straight to execution
/workflow execute

# Check where you are
/workflow status

# Resume from wherever you left off (next incomplete phase)
/workflow resume
```

---

## Phases

Phases run in a fixed order. Each phase writes a Markdown artifact to the workflow directory. A phase cannot start until its prerequisite artifact exists (unless the prerequisite phase is disabled or skipped).

| Order | Phase | Purpose | Artifact | Requires |
|-------|-------|---------|----------|----------|
| 1 | **brainstorm** | Explore problem space, generate ideas, define scope | `brainstorm.md` | — |
| 2 | **spec** | Formal requirements specification with RFC 2119 language | `spec.md` | brainstorm |
| 3 | **design** | Architecture and technical design | `design.md` | spec |
| 4 | **plan** | Ordered implementation tasks with file paths and acceptance criteria | `plan.md` | design |
| 5 | **execute** | Implement the plan | `execute.md` | plan |
| 6 | **verify** | Run tests, type checks, confirm behavior | `verify.md` | execute |
| 7 | **finish** | Changelog, commit message, cleanup | `finish.md` | verify |

Phases can be skipped individually (`/workflow skip <phase>`) or omitted from the workflow's `activePhases` during brainstorm via `propose_phases`. Skipped phases write `(skipped)` as their artifact content so the prerequisite check passes.

---

## Commands Reference

Most commands accept an optional `[slug]` argument. When omitted, the active workflow is used. If no active workflow exists, interactive mode prompts for input.

### `/workflow`

Show the status of the active workflow. If no active workflow exists, show command help.

```
/workflow
```

### `/workflow brainstorm <topic>`

Start a new workflow. The topic is used to generate the slug. In interactive mode, a slug is suggested and the user can confirm or edit it before the session begins.

```
/workflow brainstorm auth-refactor
/workflow brainstorm "redesign the settings panel"
```

If no topic is provided in interactive mode, a prompt appears for the topic.

### `/workflow spec [slug]`

Start the specification phase for the active workflow (or the named slug). Requires a completed brainstorm artifact.

```
/workflow spec
/workflow spec 2026-03-24-auth-refactor
```

### `/workflow design [slug]`

Start the architecture/design phase. Requires a completed spec.

```
/workflow design
/workflow design 2026-03-24-auth-refactor
```

### `/workflow plan [slug]`

Start the implementation planning phase. Requires a completed design.

```
/workflow plan
/workflow plan 2026-03-24-auth-refactor
```

### `/workflow execute [slug]`

Start the execution phase. Requires a completed plan.

```
/workflow execute
/workflow execute 2026-03-24-auth-refactor
```

### `/workflow verify [slug]`

Start verification. Requires a completed execute artifact and a spec artifact (for acceptance criteria).

```
/workflow verify
/workflow verify 2026-03-24-auth-refactor
```

### `/workflow finish [slug]`

Start the finalization phase. Requires a completed verify artifact.

```
/workflow finish
/workflow finish 2026-03-24-auth-refactor
```

### `/workflow resume [slug]`

Continue from the next incomplete phase. Determines the next phase by scanning `activePhases` (or all phases if none configured) for the first phase without an artifact.

```
/workflow resume
/workflow resume 2026-03-24-auth-refactor
```

If all phases are complete, reports completion.

### `/workflow back [phase] [slug]`

Re-enter a previously completed phase. Useful for revising an artifact after discovering new information.

```
/workflow back
/workflow back design
/workflow back design 2026-03-24-auth-refactor
```

Without a phase argument, interactive mode presents a picker of completed phases.

### `/workflow status [slug]`

Show a detailed phase overview for the active or named workflow, including completion markers:

- `v` — phase complete (artifact exists)
- `>` — current phase
- `o` — phase pending
- `-` — phase disabled (not in `activePhases`)

```
/workflow status
/workflow status 2026-03-24-auth-refactor
```

### `/workflow list`

List all workflows in the project. Shows slug and current phase for each. In interactive mode, selecting a workflow resumes it.

```
/workflow list
```

### `/workflow switch [slug]`

Switch the active workflow. In interactive mode, presents a picker if no slug is given.

```
/workflow switch 2026-03-24-auth-refactor
```

Switching immediately resumes the selected workflow from its current phase.

### `/workflow skip <phase> [slug]`

Mark a phase as skipped. Writes `(skipped)` as the phase artifact so downstream prerequisite checks pass without the agent actually completing the phase.

```
/workflow skip spec
/workflow skip plan 2026-03-24-auth-refactor
```

Valid phases: `brainstorm`, `spec`, `design`, `plan`, `execute`, `verify`, `finish`.

### `/workflow delete [slug]`

Delete a workflow and all its artifacts. In interactive mode, asks for confirmation.

```
/workflow delete 2026-03-24-old-feature
```

If the deleted workflow was active, clears the `.active` file.

### `/workflow rename <old-slug> <new-slug>`

Rename a workflow. Copies the directory to the new name, updates `slug` in `state.json`, deletes the old directory. Updates `.active` if the renamed workflow was active.

```
/workflow rename 2026-03-24-temp 2026-03-24-auth-refactor
```

### `/workflow abandon [slug]`

Mark the active (or named) workflow as abandoned. Sets `status: "abandoned"` in `state.json` and clears `.active`. The artifacts are preserved.

```
/workflow abandon
/workflow abandon 2026-03-24-auth-refactor
```

### `/workflow config`

Open the interactive phase configuration UI. Only available in interactive mode. Allows per-phase settings for approval mode, review agent, and maximum review rounds. Supports session-level overrides (`g` to toggle scope, `r` to reset an override).

```
/workflow config
```

### `/workflow help`

Show a brief command reference.

```
/workflow help
```

---

## Slug Naming

Slugs follow the format `YYYY-MM-DD-topic`:

- The date prefix (`YYYY-MM-DD`) is required and set to the current date at creation
- The topic is derived from the brainstorm argument: lowercased, non-alphanumeric characters replaced with hyphens, truncated to 50 characters
- Example: `/workflow brainstorm auth refactor` produces `2026-03-24-auth-refactor`

On creation, the user is asked to confirm the suggested slug in interactive mode. If a slug already exists, a warning is shown.

To use an explicit slug when calling via the agent tool `start_workflow`, pass the `slug` parameter directly.

---

## File Structure

All workflow data lives under `docs/workflow/` in the project root:

```
docs/workflow/
  .active                          — name of the active workflow slug (plain text)
  2026-03-24-auth-refactor/
    state.json                     — workflow state
    brainstorm.md                  — brainstorm artifact
    spec.md                        — requirements specification
    design.md                      — architecture design
    plan.md                        — implementation plan
    execute.md                     — execution notes
    verify.md                      — verification results
    finish.md                      — finalization notes
```

Artifacts are paths relative to the project root (e.g., `docs/workflow/2026-03-24-auth-refactor/spec.md`). The `.active` file contains a single slug name with no trailing newline. If it is absent or its slug has no `state.json`, the system falls back to the most recently dated slug.

---

## State Model

Each workflow directory contains a `state.json` file:

```typescript
interface WorkflowState {
  slug: string;
  currentPhase: WorkflowPhase;
  artifacts: Partial<Record<WorkflowPhase, string>>;
  activePhases?: WorkflowPhase[];
  status?: "active" | "abandoned";
}
```

**Fields:**

- `slug` — the directory name; redundantly stored to allow self-consistent reads
- `currentPhase` — the phase most recently activated (the "pointer"); updated on each phase start
- `artifacts` — map of phase name to relative artifact file path; a phase is considered complete when its key is present
- `activePhases` — optional ordered list of phases this workflow uses; if absent, all seven phases are considered active; set during brainstorm via `propose_phases`
- `status` — `"active"` (default, implicit) or `"abandoned"`; abandoned workflows are preserved on disk but cleared from `.active`

`WorkflowPhase` is one of: `"brainstorm"`, `"spec"`, `"design"`, `"plan"`, `"execute"`, `"verify"`, `"finish"`.

---

## Approval Flow

When an agent completes a phase, it calls `exit_plan_mode` with `workflowPhase` and `workflowSlug`. The system then:

1. Reads the phase artifact from `local://<PHASE>.md` (e.g., `local://SPEC.md`)
2. Runs the approval gate configured for that phase (see Configuration below)
3. On approval:
   - Writes the artifact to `docs/workflow/<slug>/<phase>.md`
   - Updates `state.json` (`currentPhase`, `artifacts`)
   - Advances the status bar
4. On rejection:
   - Returns the rejection reason to the agent as a message
   - The agent refines the output and calls `exit_plan_mode` again
   - User can select "Retry phase" or "Abandon phase"

**The `local://` namespace** is the staging area. Agents write phase output to `local://PLAN.md` (or the phase-named file). The system moves it to the permanent artifact location only after approval. This ensures partial work is never committed as a completed artifact.

---

## Configuration

`/workflow config` opens an interactive settings panel with per-phase controls:

| Setting | Values | Description |
|---------|--------|-------------|
| `enabled` | `true` / `false` | Whether the phase is included by default |
| `approval` | `none` / `user` / `agent` / `both` | Who must approve the phase output |
| `reviewAgent` | `critic` / `reviewer` | Which agent reviews the output (when `approval` is `agent` or `both`) |
| `maxReviewRounds` | `1`–`5` | How many agent review iterations before escalating to the user |

**Approval modes:**

- `none` — phase auto-approves immediately
- `user` — interactive approval prompt (Approve / Refine / Reject)
- `agent` — agent review runs first; the reviewing agent calls `exit_plan_mode` with `reviewCompleted: true` when done, then the phase is approved or rejected programmatically
- `both` — agent review runs first, then user approval

Settings can be stored at global scope (persisted to project settings) or session scope (overrides that last only for the current session). In the config UI, `g` toggles between scopes; session overrides are marked with `*`; `r` clears the current override.

---

## Agent Tools

Three tools are callable by the agent during a workflow session:

### `start_workflow`

Initiates a new workflow. The system creates the workflow directory, `state.json`, and starts the brainstorm phase.

```typescript
start_workflow({
  topic: string,     // short description; used to generate the slug
  slug?: string,     // explicit slug override (YYYY-MM-DD-topic format)
})
```

### `switch_workflow`

Switches the active workflow to another slug. Asks the user for confirmation unless `confirm: true`.

```typescript
switch_workflow({
  slug: string,       // the workflow slug to activate
  confirm?: boolean,  // if true, skips the confirmation prompt
})
```

### `propose_phases`

Called during brainstorm to propose which phases this workflow needs. The proposal is shown to the user for confirmation and saved to `state.json` as `activePhases`. Must be called before `exit_plan_mode` in the brainstorm phase.

```typescript
propose_phases({
  phases: string[],   // ordered subset of valid phases
  rationale: string,  // why these phases are needed or others are skipped
})
```

### `exit_plan_mode`

Signals that the agent has finished a phase. For workflow phases, `workflowSlug` and `workflowPhase` are required instead of `title`.

```typescript
exit_plan_mode({
  workflowSlug: string,     // the active workflow slug
  workflowPhase: string,    // the phase just completed
  reviewCompleted?: boolean, // set to true after agent-driven review is done
  title?: string,           // only for non-workflow plan mode
})
```

The agent must write the phase output to `local://<PHASE>.md` (e.g., `local://SPEC.md`) before calling this tool. The tool verifies the file exists and returns an error if it does not.
