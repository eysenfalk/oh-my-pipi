# Brainstorm: Workflow UX improvements

## Problems

**1. No phase back-navigation shortcut**
Returning to a previously completed phase requires knowing and typing the exact phase name (`/workflow spec`, `/workflow design`, etc.). There is no shortcut. Users working iteratively — refining a spec after seeing the plan, or redoing brainstorm after the design surfaced new scope — have no ergonomic way to go back.

**2. Slug not confirmed at workflow start**
Both `WorkflowCommand#startBrainstorm` and the `start_workflow` tool auto-generate the slug from the topic with zero user interaction. The user has no chance to rename it, and nothing enforces the `YYYY-MM-DD-` date prefix.

**3. Workflow invisible during active session**
The taskbar (status line top border) shows the workflow slug, phase, and progress — but only when `setActiveWorkflow` is called. This call only happens in two places: `handleSwitchWorkflowTool` and after `#handleWorkflowPhaseComplete`. When a workflow is started via the `/workflow` slash command, the taskbar never updates. During the entire brainstorm session, the user sees no indicator that a workflow is active.

**4. Workflow state not written until phase completes**
`state.json` is created only when `writeWorkflowArtifact` runs, which happens only after the user approves a phase output. Until the first phase is approved, the workflow does not exist on disk: `/workflow list` won't show it, there's nothing to switch back to, and no place to persist the per-slug phase config before brainstorm ends.

**5. Approval gate not triggered via slash command path**
The approval code path exists — agent writes to `local://PHASE.md`, calls `exit_plan_mode` with `workflowSlug`+`workflowPhase`, `#handleWorkflowPhaseComplete` runs the gate. But the slash command path (`WorkflowCommand#startBrainstorm`) does not put the session in plan mode, gives the agent no direct feedback if `exit_plan_mode` is never called, and doesn't connect the brainstorm session to the approval flow in a way the user can observe. The user is not asked to approve — the artifact just appears in the slug dir.

---

## Goals

1. `/workflow back` — one command to re-enter any completed phase, with a selector in interactive mode
2. Slug confirmation at start — user asked to confirm/edit the slug before the workflow is created; date prefix enforced
3. Workflow created on disk at start — `state.json` written when the slug is confirmed, before the brainstorm session begins
4. Taskbar live from start — status line shows the active slug and phase as soon as the workflow is created, not only after phase completion
5. Approval gate visible and enforced — when a phase completes, the user (and reviewer if configured) is always asked before the artifact is saved

---

## Proposed approaches

### A — Extend `HookCommandContext` with a workflow lifecycle hook

Add a `setActiveWorkflow(slug, phase, phases)` method to `HookCommandContext`. `WorkflowCommand` calls it after slug confirmation + state creation. The `InteractiveMode` implementation updates the taskbar. The start-workflow tool already works this way (it calls `setActiveWorkflow` on `InteractiveMode` directly); this path would unify the two.

**Tradeoffs:**
- Clean separation: command handler stays unaware of `InteractiveMode` internals
- Requires adding a method to `HookCommandContext` and its `InteractiveMode` implementation
- Consistent with existing pattern (`ctx.ui.notify`, `ctx.newSession`)

**Recommended.**

### B — Move slug confirmation into `handleStartWorkflowTool` and retire the slash command start path

Make `/workflow brainstorm topic` delegate entirely to `handleStartWorkflowTool` (the agent tool), which already has `InteractiveMode` access. Slug confirmation + state creation + taskbar update all live in one place.

**Tradeoffs:**
- One code path instead of two, simpler maintenance
- Loses the ability to start a workflow from the slash command without going through the tool system
- Conflates two different invocation surfaces (user slash command vs agent tool call)

### C — Introduce a dedicated `WorkflowSession` object passed through newSession

When starting a workflow phase, pass the slug and phase as metadata to `ctx.newSession()`. `InteractiveMode` extracts it to update the taskbar and track state.

**Tradeoffs:**
- Elegant coupling: session lifecycle carries its own context
- Larger change — `newSession()` API changes, all callers affected
- May be the right long-term direction but overengineered for this scope

---

## Recommended direction

**Approach A** for the workflow lifecycle hook, applied to:
- `/workflow back` with completed-phase selector (UI) or explicit arg (headless)
- Slug confirmation in `WorkflowCommand#startBrainstorm` and in `handleStartWorkflowTool`, with date-prefix enforcement
- `state.json` written at slug confirmation time with `currentPhase: "brainstorm"` and empty `artifacts: {}`
- `ctx.setActiveWorkflow(slug, phase, null)` called immediately after state creation
- Taskbar then updates live from the first moment of the brainstorm session

For the approval gate: the code path is correct. The gap is observability — the user has no feedback during the session that they will be asked. A note in the brainstorm prompt ("when you call `exit_plan_mode`, you will be prompted to approve before anything is saved") is sufficient.

---

## Open questions

1. **Slug edit UX**: Should the slug prompt be a free-text input (with validation) or a two-step "confirm or type new name" selector? Free-text is simpler to implement; a two-step selector is more ergonomic for users who mostly accept the default.
2. **`/workflow back` with active phases**: If `state.activePhases = ["brainstorm", "plan", "execute"]` and spec was skipped, should "spec" appear in the back selector? Only phases with artifacts should appear (safe, no confusion). Or all phases before current, regardless of whether they were run? Proposed: artifact-only, since returning to a phase that was never run is the same as running it fresh — just use the direct command.
3. **State overwrite on re-entry**: Going back to spec and re-completing it resets `state.currentPhase` to `spec`. Subsequent resume will re-run from spec forward. This is correct but could discard completed work (plan artifact still exists on disk but currentPhase points before it). Should the user be warned? Or is this expected behavior?

---

## Risks

- `HookCommandContext` is used across the extensibility layer; adding a method changes all implementations. Non-interactive implementations (headless context) need a no-op stub.
- Date prefix enforcement: the regex `/^\d{4}-\d{2}-\d{2}-/` is fragile for edge input. Must sanitize slug chars (lowercase alphanum + hyphens) and re-attach prefix if user removes it.
- Parallel workflows: writing `state.json` at slug confirmation time creates the workflow before any work is done. A user who cancels mid-brainstorm will leave an empty `state.json`. Cleanup is not scoped here — acceptable for now.

---

## Proposed phases

`["brainstorm", "spec", "plan", "execute", "verify"]`

Rationale: medium feature touching 4-6 files across command handler, interactive mode, and TUI. Spec needed to lock down the API contract for `HookCommandContext` changes before implementation. Design phase not needed — architecture is clear. Finish not needed — no release in scope.
