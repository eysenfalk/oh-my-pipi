# Workflow feature — full fix + enhancement plan

> **For execution:** Read `skill://agent-orchestration/SKILL.md` (recommended: subagent-driven)
> or execute tasks inline following `skill://tdd/SKILL.md`.

**Goal:** Fix all reviewed bugs and UX gaps in the workflow system, add `/workflow back`, unify the slash command and agent tool invocation paths, and implement slug confirmation + live taskbar tracking.

**Architecture:** Changes are layered: (1) harden the data layer and fix tool-level bugs in parallel; (2) extend `HookCommandContext`/`InteractiveModeContext` to expose a unified `startWorkflow` entrypoint; (3) delegate slash command handlers through that entrypoint; (4) polish UX/status rendering.

**Tech stack:** Bun, TypeScript, `@sinclair/typebox`, `@oh-my-pi/pi-tui`, custom TUI component system.

**Brainstorm:** `docs/workflow/2026-03-24-workflow-back-command/brainstorm.md`

---

## File map

```
MODIFY: packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/approval.ts
MODIFY: packages/coding-agent/src/tools/exit-plan-mode.ts
MODIFY: packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/artifacts.ts
MODIFY: packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts
MODIFY: packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/prompts/execute-start.md
MODIFY: packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/prompts/verify-start.md
MODIFY: packages/coding-agent/src/extensibility/hooks/types.ts
MODIFY: packages/coding-agent/src/modes/types.ts
MODIFY: packages/coding-agent/src/modes/interactive-mode.ts
MODIFY: packages/coding-agent/src/tools/propose-phases.ts
MODIFY: packages/coding-agent/src/tools/start-workflow.ts
MODIFY: packages/coding-agent/src/tools/switch-workflow.ts
MODIFY: packages/coding-agent/src/modes/components/status-line.ts
MODIFY: packages/coding-agent/src/modes/components/status-line/segments.ts
```

---

## Execution order

### Parallel Group A — independent, no file overlap

- **Task 1** — Approval gate hardening (`approval.ts`, `exit-plan-mode.ts`, `interactive-mode.ts`)
- **Task 2** — Artifacts hardening (`artifacts.ts`)
- **Task 3** — WorkflowCommand existing fixes (`workflow/index.ts`)
- **Task 4** — Prompt fixes (`prompts/execute-start.md`, `prompts/verify-start.md`)

### Sequential (each depends on the previous)

- **Task 5** — Unified workflow lifecycle in context layer (`hooks/types.ts`, `modes/types.ts`, `interactive-mode.ts`)
- **Task 6** — WorkflowCommand delegation + agent tool cleanup + `/workflow back` (`workflow/index.ts`, `start-workflow.ts`, `switch-workflow.ts`, `propose-phases.ts`)
- **Task 7** — Status bar polish + approval UX + style cleanup (`status-line.ts`, `segments.ts`, `interactive-mode.ts`)

---

## Task 1 — Approval gate hardening

**Agent tier:** `senior_task`
**Parallel group:** A
**Files:**
- Modify: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/approval.ts`
- Modify: `packages/coding-agent/src/tools/exit-plan-mode.ts`
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts` (`#handleWorkflowPhaseComplete` only)

### Problems fixed
1. `runApprovalGate` has no `default` case — falls off the switch with `undefined`, crashes callers
2. `both` approval mode loops infinitely — agent calls `exit_plan_mode`, gate re-triggers, returns another review prompt forever
3. `maxReviewRounds` is communicated to the agent via prompt text but never enforced in code
4. `workflowPhase` passed to `#handleWorkflowPhaseComplete` is cast `as WorkflowPhase` without validation
5. `Refine`: sets editor text with the reason but doesn't re-prompt the agent — the agent never acts on the refinement
6. `Reject`: stuffs `"Rejected"` into the editor with no actionable next step

### Changes

**`approval.ts`:**

- Add `default` case to `runApprovalGate` switch:
  ```typescript
  default:
      logger.warn("Unknown approval mode, defaulting to user approval", { approvalMode });
      // fall through to user approval
  ```
  Then share the `user` case body. Import `logger` from `@oh-my-pi/pi-utils`.

- In `buildReviewPrompt`, extend the returned text to instruct the agent:
  > "When the review is complete (approved or rejected after all rounds), call `exit_plan_mode` with `reviewCompleted: true` to proceed."

**`exit-plan-mode.ts`:**

- Add `reviewCompleted` to `exitPlanModeSchema`:
  ```typescript
  reviewCompleted: Type.Optional(Type.Boolean({
      description: "Set to true after agent review is complete (used with both-mode approval). Signals the system to proceed to user approval.",
  })),
  ```
- Add `reviewCompleted?: boolean` to `ExitPlanModeDetails`.
- Pass it through in the `execute` return value.

**`interactive-mode.ts` (`#handleWorkflowPhaseComplete`):**

- Add a field `#reviewRoundCount = new Map<string, number>()`. Key is `"${slug}/${phase}"`.

- Before calling `runApprovalGate`, check if `details.reviewCompleted === true`. If so, force `approvalMode` to `"user"` for this invocation (skip agent review, go straight to user gate).

- After dispatching a review prompt via `onInputCallback`, increment the round count for the key. After the phase is approved or rejected, `delete` the key from the map.

- In `runApprovalGate` (or in the caller): after dispatching `reviewPrompt`, check if `roundCount >= maxRounds`. If so, skip back to user approval. Pass the resolved `maxRounds` through to the caller, or add a helper function `#shouldEscalateToUser(slug, phase, maxRounds): boolean`.

- **Refine fix:** After the user inputs the refinement reason, submit it as a user message to the agent (not just set editor text):
  ```typescript
  if (choice === "Refine") {
      const reason = await ctx.input("What needs refinement?");
      if (reason && this.onInputCallback) {
          this.onInputCallback(this.startPendingSubmission({ text: reason }));
      }
      return;  // agent re-runs; will call exit_plan_mode again when ready
  }
  ```

- **Reject fix:** Show two options: `"Reject and retry"` / `"Reject and abandon phase"`. For retry, clear editor (agent can try again). For abandon, notify and return without any action.

### Verification
- Run `bun check:ts` — no new type errors.
- Manually verify `both` mode by setting a phase to `both` in workflow config, completing the phase, confirming the agent review fires once, then user is asked to approve.
- Confirm round count resets after phase completes.

---

## Task 2 — Artifacts hardening

**Agent tier:** `task`
**Parallel group:** A
**Files:**
- Modify: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/artifacts.ts`

### Problems fixed
1. `writeWorkflowArtifact` writes artifact file first, then state.json — crash between writes leaves them desynced
2. `WorkflowState.currentPhase` typed as `string`, should be `WorkflowPhase`
3. `WorkflowState.activePhases` typed as `string[]`, should be `WorkflowPhase[]`
4. `setActiveWorkflowPhase` is exported but never imported anywhere — dead code
5. `WORKFLOW_DIR` is duplicated in `artifacts.ts` and `index.ts` — artifacts.ts should export it
6. No way to create initial workflow state before brainstorm starts
7. No active workflow persistence — `findActiveWorkflow` sorts by date, ignores explicit user selection

### Changes

**Write order fix (atomicity):** Swap the write order in `writeWorkflowArtifact`: write `state.json` first, then the artifact file. Worst case on crash = state references a phase that has no artifact file, which `readWorkflowArtifact` returns `null` for (already handled by `#checkPrereq`). This is safer than the reverse.

**Type tightening:**
```typescript
export interface WorkflowState {
    slug: string;
    currentPhase: WorkflowPhase;
    artifacts: Partial<Record<WorkflowPhase, string>>;
    activePhases?: WorkflowPhase[];
    status?: "active" | "abandoned";
}
```
Update all places where `currentPhase` or `activePhases` are read/written to use `WorkflowPhase` correctly. In `readWorkflowState`, validate `currentPhase` against `PHASES` after parsing JSON — if invalid, fall back to `"brainstorm"` and log a warning.

**Dead code removal:** Delete `setActiveWorkflowPhase` (exported but never imported).

**Export `WORKFLOW_DIR`:** Change `const WORKFLOW_DIR` to `export const WORKFLOW_DIR`.

**Add `createWorkflowState`:**
```typescript
export async function createWorkflowState(cwd: string, slug: string): Promise<void> {
    const dir = resolveWorkflowDir(cwd, slug);
    await fs.mkdir(dir, { recursive: true });
    const initial: WorkflowState = { slug, currentPhase: "brainstorm", artifacts: {} };
    await Bun.write(path.join(dir, "state.json"), JSON.stringify(initial, null, 2));
}
```

**Active workflow persistence:**
```typescript
const ACTIVE_FILE = ".active";

export async function getActiveWorkflowSlug(cwd: string): Promise<string | null> {
    try {
        const text = (await Bun.file(path.join(cwd, WORKFLOW_DIR, ACTIVE_FILE)).text()).trim();
        return text || null;
    } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
    }
}

export async function setActiveWorkflowSlug(cwd: string, slug: string | null): Promise<void> {
    const filePath = path.join(cwd, WORKFLOW_DIR, ACTIVE_FILE);
    if (slug === null) {
        try { await fs.unlink(filePath); } catch (err) { if (!isEnoent(err)) throw err; }
    } else {
        await Bun.write(filePath, slug);
    }
}
```

**Update `findActiveWorkflow`:** Check `getActiveWorkflowSlug` first. If it returns a slug and that slug has a valid state.json, return it. Otherwise fall back to date-sorted list.

### Verification
- `bun check:ts` — no type errors.
- Manually delete an artifact file, confirm `#checkPrereq` returns the expected error without crash.
- Write a state.json with an invalid `currentPhase` value, confirm `readWorkflowState` returns it with fallback logged.

---

## Task 3 — WorkflowCommand existing fixes

**Agent tier:** `mid_task`
**Parallel group:** A
**Files:**
- Modify: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts`

### Problems fixed
1. No-arg `/workflow` shows only workflow status or "no active workflow" — no help, no subcommand list
2. Unknown subcommands fall through to brainstorm (e.g. `/workflow back` brainstorms about "back")
3. `/workflow switch` pre-fills editor instead of acting
4. `/workflow list` in UI pre-fills editor instead of acting
5. `#startDesign`, `#startPlan`, `#startExecute` have no `#checkPrereq` calls — inconsistent gating
6. `WORKFLOW_DIR` duplicated with `artifacts.ts`

### New subcommands
7. `/workflow status [slug]` — rich phase overview
8. `/workflow delete [slug]` — delete a workflow (confirm first)
9. `/workflow rename <slug> <new-name>` — rename (copy files, update state.json, delete old)
10. `/workflow skip <phase> [slug]` — mark a phase as skipped without running it
11. `/workflow abandon [slug]` — mark workflow as abandoned (`status: "abandoned"` in state.json)

### Changes

**Import `WORKFLOW_DIR` from `./artifacts`** instead of re-declaring it. Remove the local `const WORKFLOW_DIR`.

**`default` case in `execute` switch:** Replace with:
```typescript
default:
    return this.#showHelp(ctx);
```
Add `#showHelp`:
```typescript
#showHelp(ctx: HookCommandContext): string {
    const cmds = [
        "brainstorm <topic>  start new workflow",
        "spec/design/plan/execute/verify/finish  run a specific phase",
        "resume [slug]       continue from current phase",
        "back [phase]        re-enter a completed phase",
        "status [slug]       show all phases and completion",
        "list                list all workflows",
        "switch [slug]       switch active workflow",
        "skip <phase>        mark a phase as skipped",
        "delete [slug]       delete a workflow",
        "rename <slug> <new> rename a workflow",
        "abandon [slug]      mark workflow as abandoned",
        "config              open phase configuration",
    ];
    return cmds.map(l => `  /workflow ${l}`).join("\n");
}
```

**No-arg `execute`:** When `!subcommand`, check if there's an active workflow. If yes, show status (call `#showStatus`). If no, show help.

**`/workflow switch` acts:** In `#switchWorkflow`, after selecting a slug, call `this.#resume([slug], ctx)` and return its result. Remove the `setEditorText` / `notify` calls.

**`/workflow list` acts:** In `#listWorkflows` (interactive branch), after `ui.select`, parse the slug and call `this.#resume([slug], ctx)` directly. Return its result.

**Prereq consistency:** Add `#checkPrereq` calls:
- `#startDesign`: replace the manual `if (!specRef) return error` check with `await this.#checkPrereq(ctx.cwd, slug, "spec")`. Remove the manual specRef check — `#checkPrereq` already handles the case where spec is not in `activePhases` (returns null, allowing design to proceed). Keep the `specRef` variable fetch for the template context, just don't gate on it.
- `#startPlan`: add `await this.#checkPrereq(ctx.cwd, slug, "design")`.
- `#startExecute`: replace the direct `if (!planRef) return error` with `await this.#checkPrereq(ctx.cwd, slug, "plan")` — same semantics but respects `activePhases`.

**`/workflow status [slug]`:**
```typescript
async #showDetailedStatus(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
    const slug = await this.#resolveSlug(rest, ctx);
    if (!slug) return "No active workflow found.";
    const state = await readWorkflowState(ctx.cwd, slug);
    if (!state) return `No state found for workflow "${slug}".`;
    const order: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
    const lines = [`Workflow: ${slug}`, `Status: ${state.status ?? "active"}`, ""];
    for (const phase of order) {
        const isActive = !state.activePhases || state.activePhases.includes(phase);
        const hasArtifact = !!state.artifacts[phase];
        const isCurrent = state.currentPhase === phase;
        const marker = !isActive ? "–" : hasArtifact ? "✓" : isCurrent ? "→" : "○";
        lines.push(`  ${marker} ${phase}`);
    }
    return lines.join("\n");
}
```

**`/workflow delete [slug]`:** Resolve slug. In UI, confirm with `ctx.ui.confirm(...)`. Delete the `docs/workflow/<slug>/` directory. If deleted slug was the active workflow (`getActiveWorkflowSlug`), call `setActiveWorkflowSlug(cwd, null)`.

**`/workflow rename <slug> <new-name>`:** Validate both args. Copy files: create new dir, copy each file in old dir. Update `state.json` in new dir with `slug: newSlug`. Delete old dir. If old was active, update `.active` to new slug.

**`/workflow skip <phase> [slug]`:** Resolve slug and phase. Validate phase is a known `WorkflowPhase`. Call `writeWorkflowArtifact(cwd, slug, phase, "(skipped)")`. Notify user.

**`/workflow abandon [slug]`:** Read state, set `state.status = "abandoned"`, write back. Notify user. Clear `.active` if it pointed to this slug.

**`#resolveSlug` update:** Use `getActiveWorkflowSlug` (imported from artifacts) as first-choice before `findActiveWorkflow`. This respects explicit user selection.

### Verification
- `bun check:ts`
- Run `/workflow` with no args → shows help or current status
- Run `/workflow unknownstuff` → shows help, does not start a session
- Run `/workflow list` → selecting a workflow starts it (not pre-fill)

---

## Task 4 — Prompt fixes

**Agent tier:** `quick_task`
**Parallel group:** A
**Files:**
- Modify: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/prompts/execute-start.md`
- Modify: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/prompts/verify-start.md`

### Changes

**`execute-start.md`:** `#populateLocalSetup` loads brainstorm, spec, design, and plan artifacts into `local://`. The prompt mentions `planRef` and `specRef` but not the design artifact. Add:

```
{{#if designRef}}Prior design artifact is available at `local://DESIGN.md` — read it for architecture decisions that constrain implementation.{{/if}}
```

Note: `designRef` is NOT currently fetched in `#startExecute` — it only fetches `planRef` and `specRef`. Add: `const designRef = await this.#artifactRef(ctx.cwd, slug, "design");` and pass it to `renderPromptTemplate(executePrompt, { planRef, specRef, designRef, slug, workflowPhase: "execute" })`. This must be done in Task 6 (which modifies `workflow/index.ts`).

**`verify-start.md`:** Replace hardcoded `bun test`, `bun check:ts`, `bun lint:ts` with:

```
Run the project's test suite, type checker, and linter. Check `AGENTS.md`, `package.json`, or `Makefile` for the correct commands — do not assume a specific runtime or tool. If no test commands are documented, check `bun run test`, `npm test`, or `make test` in that order.
```

### Verification
- Read both files and confirm Bun-specific commands are gone.
- Confirm `execute-start.md` mentions `local://DESIGN.md` in a conditional block.

---

## Task 5 — Unified workflow lifecycle in context layer

**Agent tier:** `senior_task`
**Sequential after Group A**
**Files:**
- Modify: `packages/coding-agent/src/extensibility/hooks/types.ts`
- Modify: `packages/coding-agent/src/modes/types.ts`
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts`

### Problem
The slash command path (`WorkflowCommand#startBrainstorm`) and the agent tool path (`handleStartWorkflowTool`) both start a new workflow but do different things. The slash command path: auto-generates slug, no confirmation, no `state.json` creation, no taskbar update. The agent tool path: aborts session, creates new session, updates taskbar — but also no slug confirmation, no `state.json` creation. Neither path is complete. During any workflow phase (spec, design, etc.), the slash command path does not update the taskbar.

### New methods on `HookCommandContext`

```typescript
/**
 * Start a new workflow: prompt for slug confirmation, enforce date prefix,
 * detect collision, write initial state.json, update taskbar.
 * Returns the prompt string to inject into the new session, or undefined if cancelled.
 */
startWorkflow(topic: string, slug?: string): Promise<string | undefined>;

/**
 * Notify the harness that a workflow phase session is starting.
 * Updates the taskbar with the active slug and phase immediately.
 */
activateWorkflowPhase(slug: string, phase: string): Promise<void>;

/**
 * Switch to a different workflow. Updates taskbar and active slug persistence.
 * Returns resume prompt or undefined if cancelled.
 */
switchWorkflow(slug: string, confirm?: boolean): Promise<string | undefined>;
```

Add all three to `HookCommandContext` in `hooks/types.ts`. Also add `startWorkflow` and `switchWorkflow` to `InteractiveModeContext` in `modes/types.ts` (same signatures).

### `InteractiveMode` implementation

**`startWorkflow(topic, slug?)`:**
1. If `ctx.hasUI`, show `ctx.ui.input("Workflow name", generateSlug(topic))` pre-filled
2. If user cancels → return `undefined`
3. Validate slug: enforce `YYYY-MM-DD-` prefix. If user removed the date prefix, re-attach today's date. Sanitize the suffix (lowercase alphanumeric + hyphens).
4. Check for collision: if `readWorkflowState(cwd, slug)` returns a non-null state:
   - Show selector: `["Resume existing workflow", "Create new (add suffix)", "Cancel"]`
   - "Resume" → call `switchWorkflow(slug)` and return `undefined` (don't start fresh)
   - "Create new" → append `-2` (or increment suffix) to make slug unique
   - "Cancel" → return `undefined`
5. Write initial state.json: `await createWorkflowState(cwd, slug)`
6. Set active slug: `await setActiveWorkflowSlug(cwd, slug)`
7. Update taskbar: `this.setActiveWorkflow(slug, "brainstorm", null)`
8. Start session: `await this.session.abort(); await this.session.newSession({})`
9. Return `renderPromptTemplate(brainstormPrompt, { topic, workflowDir: path.join(WORKFLOW_DIR, slug), slug, workflowPhase: "brainstorm" })`

The returned prompt string is injected by the caller (WorkflowCommand returns it; handleStartWorkflowTool submits it via `onInputCallback`).

**`activateWorkflowPhase(slug, phase)`:**
```typescript
async activateWorkflowPhase(slug: string, phase: string): Promise<void> {
    const cwd = this.sessionManager.getCwd();
    const state = await readWorkflowState(cwd, slug);
    this.setActiveWorkflow(slug, phase, state?.activePhases ?? null);
}
```

**`switchWorkflow(slug, confirm?)`:**
1. Read state — if none, show error and return `undefined`
2. If `!confirm` and `hasUI`, show confirmation
3. Call `setActiveWorkflowSlug(cwd, slug)`
4. Call `this.setActiveWorkflow(slug, state.currentPhase, state.activePhases ?? null)`
5. Return `this.#resume([slug], ctx)` result — i.e., start the next-phase session and return its prompt, OR `undefined` if no next phase

For non-interactive (no UI): skip confirmation if `!confirm`, still update state.

**Refactor `handleStartWorkflowTool`:** Delegate to `this.startWorkflow(details.topic, details.slug)`. Submit the returned prompt via `onInputCallback` if not undefined.

**Refactor `handleSwitchWorkflowTool`:** Delegate to `this.switchWorkflow(details.slug, details.confirm)`. Submit returned prompt if not undefined.

**Wire `HookCommandContext` implementations:** There are TWO locations where `HookCommandContext` is constructed:
1. The hook runner (primary path) — find where the context object is built for slash command handlers and add `startWorkflow`, `activateWorkflowPhase`, `switchWorkflow` methods delegating to the corresponding `InteractiveMode` methods.
2. `AgentSession` fallback path — there is a secondary context construction in `AgentSession` (used when no extension runner exists). Add no-op / error stubs for these three methods to that fallback: `startWorkflow: async () => undefined`, `activateWorkflowPhase: async () => {}`, `switchWorkflow: async () => undefined`.
For non-interactive (headless) contexts: all three methods should return `undefined`/`void` immediately without showing UI.

### Verification
- `bun check:ts`
- Verify no references to the old direct `handleStartWorkflowTool` body remain (it should just delegate now).

---

## Task 6 — WorkflowCommand delegation + tool cleanup + `/workflow back`

**Agent tier:** `mid_task`
**Sequential after Task 5**
**Files:**
- Modify: `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts`
- Modify: `packages/coding-agent/src/tools/start-workflow.ts`
- Modify: `packages/coding-agent/src/tools/switch-workflow.ts`
- Modify: `packages/coding-agent/src/tools/propose-phases.ts`

### Changes

**`WorkflowCommand#startBrainstorm`:** Replace the current body with:
```typescript
async #startBrainstorm(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
    const topic = rest.join(" ");
    if (!topic) {
        if (!ctx.hasUI) return "Usage: /workflow brainstorm <topic>";
        const input = await ctx.ui.input("Brainstorm topic", "What do you want to build?");
        if (!input) return undefined;
        return ctx.startWorkflow(input);
    }
    return ctx.startWorkflow(topic);
}
```

**`WorkflowCommand#switchWorkflow`:** Replace with:
```typescript
async #switchWorkflow(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
    if (!ctx.hasUI && rest.length === 0) return "Usage: /workflow switch <slug>";
    const slugs = await listWorkflows(ctx.cwd);
    if (slugs.length === 0) {
        if (ctx.hasUI) { ctx.ui.notify("No workflows found.", "info"); return undefined; }
        return "No workflows found.";
    }
    const selected = rest[0] ?? (await ctx.ui.select("Switch to workflow", slugs));
    if (!selected) return undefined;
    return ctx.switchWorkflow(selected);
}
```

**Each `#startPhase` method:** Add `await ctx.activateWorkflowPhase(slug, phase)` before `await ctx.newSession({ setup })`. This ensures the taskbar shows the correct phase as soon as the session starts.

Example for `#startSpec`:
```typescript
await ctx.activateWorkflowPhase(slug, "spec");
await ctx.newSession({ setup });
return renderPromptTemplate(specPrompt, { ... });
```

Apply to: `#startSpec`, `#startDesign`, `#startPlan`, `#startExecute`, `#startVerify`, `#startFinish`.

**Add `case "back":` to the `execute` switch.** Add `#startBack` method:

```typescript
async #startBack(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
    const slug = await this.#resolveSlug([], ctx);
    if (!slug) return "No active workflow found.";

    const state = await readWorkflowState(ctx.cwd, slug);
    if (!state) return `No state found for workflow "${slug}".`;

    const order: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
    const completedInOrder = order.filter(p => state.artifacts[p]);

    if (completedInOrder.length === 0) {
        const msg = "No completed phases to go back to.";
        if (ctx.hasUI) { ctx.ui.notify(msg, "info"); return undefined; }
        return msg;
    }

    let targetPhase: WorkflowPhase;

    if (rest.length > 0) {
        const arg = rest[0] as WorkflowPhase;
        if (!state.artifacts[arg]) {
            return `Phase "${arg}" has no completed artifact for workflow "${slug}".`;
        }
        if (!order.includes(arg)) {
            return `Unknown phase "${arg}". Valid phases: ${order.join(", ")}.`;
        }
        targetPhase = arg;
    } else if (ctx.hasUI) {
        const selected = await ctx.ui.select("Go back to phase", completedInOrder);
        if (!selected) return undefined;
        targetPhase = selected as WorkflowPhase;
    } else {
        return `Usage: /workflow back <phase>  (completed phases: ${completedInOrder.join(", ")})`;
    }

    return this.#dispatchToPhase(targetPhase, slug, ctx);
}
```

Add `#dispatchToPhase(phase, slug, ctx)` helper (extracted from `#resume` switch, extended with brainstorm):

```typescript
#dispatchToPhase(phase: WorkflowPhase, slug: string, ctx: HookCommandContext): Promise<string | undefined> {
    switch (phase) {
        case "brainstorm": {
            // ctx.startWorkflow() is for NEW workflow creation — it triggers collision checks,
            // rewrites state.json, and prompts for slug confirmation. Wrong for back-navigation.
            // Inline re-entry instead: preserve existing state, just start a fresh session.
            const topic = slug.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
            await ctx.activateWorkflowPhase(slug, "brainstorm");
            await ctx.newSession();
            return renderPromptTemplate(brainstormPrompt, {
                topic,
                workflowDir: path.join(WORKFLOW_DIR, slug),
                slug,
                workflowPhase: "brainstorm",
            });
        }
        case "spec":     return this.#startSpec([slug], ctx);
        case "design":   return this.#startDesign([slug], ctx);
        case "plan":     return this.#startPlan([slug], ctx);
        case "execute":  return this.#startExecute([slug], ctx);
        case "verify":   return this.#startVerify([slug], ctx);
        case "finish":   return this.#startFinish([slug], ctx);
        default:         return Promise.resolve(`Unknown phase "${phase}".`);
    }
}
```

Replace `#resume`'s inline switch with a call to `#dispatchToPhase`:
```typescript
const nextPhase = this.#getNextPhase(state);
if (!nextPhase) return `Workflow "${slug}" complete at "${state.currentPhase}".`;
return this.#dispatchToPhase(nextPhase as WorkflowPhase, slug, ctx);
```

**Agent tool cleanup:**

`start-workflow.ts`, `switch-workflow.ts`, `propose-phases.ts` all have `constructor(readonly _session: ToolSession)`. Change to `constructor(_session: ToolSession)` (no implicit field) since the session is not used — these tools use the details-return pattern, not direct session method calls.

### Verification
- `bun check:ts`
- `/workflow back` from a workflow with completed phases → shows selector, dispatching to a phase starts a session
- `/workflow back brainstorm` → re-enters brainstorm without creating a duplicate slug
- `/workflow brainstorm <topic>` → prompts for slug confirmation (via Task 5), then starts

---

## Task 7 — Status bar polish + approval UX + style fix

**Agent tier:** `mid_task`
**Sequential after Task 6**
**Files:**
- Modify: `packages/coding-agent/src/modes/components/status-line.ts`
- Modify: `packages/coding-agent/src/modes/components/status-line/segments.ts`
- Modify: `packages/coding-agent/src/modes/interactive-mode.ts`

### Changes

**`status-line.ts` style fix (pre-existing debt, fix opportunistically):** The constructor uses `private readonly session: AgentSession` instead of `#session` (AGENTS.md violation). Change to:
```typescript
#session: AgentSession;
constructor(session: AgentSession) {
    this.#session = session;
}
```
Update all internal references from `this.session` to `this.#session`. Pure rename, no behavior change.

**Status bar stale phase:** After `#handleWorkflowPhaseComplete` approves and saves an artifact, it calls `setActiveWorkflow(slug, phase, ...)`. This means the status bar stays on e.g. `[brainstorm]` while the user is in a spec session. The fix: after persisting the artifact and updating active workflow tracking, determine the next phase (using `#getNextPhase` logic or simply leave the display as `[phase complete]`). Display the next expected phase in the status bar as `[spec →]` (arrow indicating pending) vs `[spec ✓]` (completed), so the user knows where they are.

Concretely: extend `setPlanModeStatus` to accept an optional `workflowNextPhase?: string`. Add this to the status data structure. In `segments.ts`, if `workflowNextPhase` is set, show `slug [phase ✓ → nextPhase]`. In `#handleWorkflowPhaseComplete`, after saving, read the state and compute the next phase, then call `setActiveWorkflow(slug, phase, activePhases)` with an additional next-phase hint.

Alternatively (simpler): After `#handleWorkflowPhaseComplete` approves, add ` (complete)` to the phase label in the status bar, and leave it until the user starts the next phase via a `/workflow resume` or phase command (which calls `activateWorkflowPhase`).

**Simplest viable fix:** In `#handleWorkflowPhaseComplete`, after the artifact is saved, compute the next phase from the updated state and call `this.setActiveWorkflow(slug, nextPhase ?? phase, activePhases)` — i.e., advance the taskbar to the next phase immediately, so it shows what's expected next. If there's no next phase (workflow complete), show the current phase still.

Implementation in `interactive-mode.ts` (post-approval block):
```typescript
const updatedState = await readWorkflowState(cwd, slug);
const nextPhase = updatedState ? this.#computeNextPhase(updatedState) : null;
this.setActiveWorkflow(slug, nextPhase ?? phase, updatedState?.activePhases ?? null);
```

Where `#computeNextPhase` mirrors `WorkflowCommand#getNextPhase` logic (duplicating it or extracting it to a shared util — prefer extracting it to `artifacts.ts` as `getNextPhase(state): WorkflowPhase | null`).

**Auto-continue option:** In the approval selector, add an `"Approve and continue"` option:
```typescript
const choice = await ctx.select(`${capitalize(phase)} phase complete — review and approve`, [
    "Approve",
    "Approve and continue",
    "Refine",
    "Reject",
]);
```
If `"Approve and continue"`, after persisting the artifact, programmatically submit `/workflow resume <slug>` as the next user input:
```typescript
if (this.onInputCallback) {
    this.onInputCallback(this.startPendingSubmission({ text: `/workflow resume ${slug}` }));
}
```

**`workflowPhases` shown from state:** Currently `#activeWorkflowPhases` (used for progress counter in status bar) is only populated when the user accepts a `propose_phases` suggestion. If `state.activePhases` is already set (from a prior brainstorm), populate it when `activateWorkflowPhase` is called — read the state and pass `state.activePhases` to `setActiveWorkflow`.

In `InteractiveMode.activateWorkflowPhase`:
```typescript
async activateWorkflowPhase(slug: string, phase: string): Promise<void> {
    const cwd = this.sessionManager.getCwd();
    const state = await readWorkflowState(cwd, slug);
    this.setActiveWorkflow(slug, phase, state?.activePhases ?? null);
}
```
(Already specified in Task 5 — ensure it's implemented this way.)

### Verification
- `bun check:ts`
- After completing a phase, taskbar advances to the next expected phase (not stuck on completed phase)
- "Approve and continue" in the approval gate automatically starts the next phase session
- Status bar shows progress counter once `activePhases` is set (from brainstorm proposal or existing state)

---

## Post-execution

After all 7 tasks complete:

```bash
bun check:ts   # must pass with zero errors
bun lint:ts    # must pass clean
```

Manual smoke test:
1. `/workflow brainstorm auth redesign` → slug confirmation dialog appears, pre-filled with `YYYY-MM-DD-auth-redesign`
2. Accept slug → status bar shows `auth-redesign [brainstorm]` immediately
3. Agent writes to `local://BRAINSTORM.md`, calls `exit_plan_mode` → approval gate fires, user is asked
4. Approve → artifact saved, status bar advances to next phase
5. "Approve and continue" → next phase session starts automatically
6. `/workflow back` from spec phase → shows `["brainstorm"]`, selecting it re-enters brainstorm
7. `/workflow status` → shows all phases with `✓ / → / ○ / –` markers
8. `/workflow unknowncommand` → shows help, does not start a brainstorm session
