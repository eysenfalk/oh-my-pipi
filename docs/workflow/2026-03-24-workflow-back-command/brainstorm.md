# Brainstorm: /workflow back command

## Problem

The workflow system has forward-only navigation. Re-entering a past phase requires typing the full phase name (`/workflow spec`, `/workflow design`, etc.), which is verbose and requires the user to know which phase to name. There is no shortcut for "go back to a previous phase".

## Goal

Add a `/workflow back` command that lets users re-enter a previously completed phase via a phase selector UI, or via an explicit phase argument.

## Scope

Single file change: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts`

## Design

### Command surface

| Invocation | Behavior |
|---|---|
| `/workflow back` (interactive) | Show selector of completed phases in phase order; dispatch on selection |
| `/workflow back <phase>` | Directly re-enter the named phase (UI and non-UI) |
| `/workflow back` (non-interactive) | Return usage error: explicit phase required |

"Completed phase" = any phase present in `state.artifacts`. Phases are displayed in canonical order (`brainstorm → spec → design → plan → execute → verify → finish`).

### State semantics

No state mutation on entry. `state.currentPhase` only updates when the agent completes the phase via `exit_plan_mode` and `writeWorkflowArtifact` runs — same as direct phase commands today. Going back and re-completing a phase will correctly reset `currentPhase` to that phase.

### Implementation

**New private method: `#startBack(rest, ctx)`**
- Resolve slug via `#resolveSlug([], ctx)`
- Read state; error if none
- Build completed-phases list from `state.artifacts`, ordered by canonical phase order
- UI mode + no arg: `ctx.ui.select(...)` over completed phases
- Non-UI + no arg: return usage hint
- Arg given: validate it has an artifact, error if not
- Dispatch via extracted helper

**Extract: `#dispatchToPhase(phase, slug, ctx)`**
- Pull the dispatch switch out of `#resume` into a shared method — but as a **superset**: `#resume` never dispatches to brainstorm (it only advances forward); `#startBack` does
- Both `#resume` and `#startBack` call it; reduces duplication (DRY at 2)
- For all phases except brainstorm: call the corresponding `#start*` method with `[slug]` args
- **Brainstorm special case:** `#startBrainstorm(rest, ctx)` treats `rest` as a *topic*, calls `generateSlug(topic)`, and would corrupt the slug when given a slug as argument. For brainstorm, `#dispatchToPhase` inlines re-entry: derive `topic` from the slug by stripping the `YYYY-MM-DD-` prefix and replacing hyphens with spaces (lossy but sufficient for prompt context); compute `workflowDir` via `path.join(WORKFLOW_DIR, slug)`; call `ctx.newSession()`; render `brainstormPrompt` with `{ topic, workflowDir, slug, workflowPhase: "brainstorm" }` — no slug regeneration, no `generateSlug` call

**Add `case "back":` to the command switch**

### Non-goals

- Loading the existing phase artifact for revision
- Multi-step back (`/workflow back 2`)
- Changing prerequisite-check logic
- Status line changes
