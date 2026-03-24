# E2E Test Framework

End-to-end integration tests for the OMP workflow system. Tests the full orchestration layer: phase ordering, artifact I/O, data flow, command routing, settings propagation, approval gates, TUI wiring, and prompt template rendering.

## Architecture

| Layer | Tests | Runtime | LLM | CI |
|---|---|---|---|---|
| **Deterministic** | State machine, file I/O, prerequisites, approval, commands, prompts, events | ~2s | None | Always |
| **TUI Wiring** | Keyboard navigation, selector/input/config components, approval flows | ~2s | None | Always |
| **Orchestration** | InteractiveMode integration: handleExitPlanModeTool, approval gates, artifact persistence, phase transitions, user journeys | ~2s | None | Always |
| **RPC E2E** | Full workflow via RPC protocol with real LLM | 60-240s/test | MiniMax M2.7 | Gated |

### File layout

```
test/e2e/
  # Deterministic tests (no LLM)
  workflow-artifacts.test.ts       # 48 tests — artifact function coverage
  workflow-artifacts-edge.test.ts  # 40 tests — corrupted state, unicode, edge cases
  workflow-approval.test.ts        # 21 tests — approval gate logic (4 modes)
  workflow-approval-edge.test.ts   # 27 tests — settings propagation, review rounds, cancel paths
  workflow-e2e.test.ts             # 48 tests — WorkflowCommand routing + pipeline
  workflow-commands-edge.test.ts   # 62 tests — every edge case in every command method
  workflow-prompts.test.ts         # 49 tests — all 7 phase templates + rendering
  workflow-events.test.ts          # 56 tests — tool event contracts + data flow
  
  # TUI tests
  tui-workflow.test.ts             # 19 tests — HookSelector/Input basics
  tui-workflow-advanced.test.ts    # 35 tests — countdown, config component, all keys
  
  # Orchestration tests (InteractiveMode integration)
  workflow-orchestration.test.ts   # 38 tests — handleExitPlanModeTool, approval gates, user journeys
  
  # Real LLM tests (gated)
  workflow-rpc-e2e.test.ts         #  7 tests — real LLM via RPC (MiniMax M2.7)
  
  # Harnesses
  workflow-harness.ts              # MockHookCommandContext, assertion helpers
  interactive-mode-harness.ts      # InteractiveMode + VirtualTerminal + patched UI
  tui-harness.ts                   # VirtualTerminal TUI environment

**Total: 450 tests (443 deterministic + 7 gated)**

## Running tests

```bash
# All deterministic tests (no API key needed)
cd packages/coding-agent && bun test test/e2e/

# Specific layer
bun test test/e2e/workflow-artifacts.test.ts
bun test test/e2e/workflow-artifacts-edge.test.ts
bun test test/e2e/tui-workflow.test.ts
bun test test/e2e/tui-workflow-advanced.test.ts

# RPC E2E (requires MiniMax API key)
MINIMAX_CODE_API_KEY=sk-... bun test test/e2e/workflow-rpc-e2e.test.ts

# All E2E via package script
bun run test:e2e
```

## Test coverage by area

### Artifact functions (`workflow-artifacts.test.ts` + `workflow-artifacts-edge.test.ts`)

88 tests total. Direct imports of functions from `artifacts.ts`:

- `writeWorkflowArtifact` — creation, updates, empty/unicode/10KB+ content, out-of-order writes
- `readWorkflowState` — read back, ENOENT, corrupted JSON, missing fields, unknown phases
- `readWorkflowArtifact` — read back, empty files, binary content, path traversal
- `createWorkflowState` — initial state, activePhases, double-create overwrite
- `getNextPhase` — sequential walk, activePhases filtering, boundary (first/last), unknown phase
- `listWorkflows` — directory listing, sort order, empty, files mixed with dirs
- `generateSlug` — date prefix, sanitization, max length, empty/special-only topics, consecutive dashes
- `formatWorkflowStatus` — human-readable output, no artifacts, abandoned status
- `setActiveWorkflowSlug` / `getActiveWorkflowSlug` / `findActiveWorkflow` — .active file, whitespace, fallback
- `updateWorkflowActivePhases` — phase filter updates, empty arrays, non-existent workflows
- `persistPhaseLearnings` — create, append, multiple calls, empty content
- **Phase prerequisites** — full chain: brainstorm (none) -> spec (brainstorm) -> design (spec) -> plan (spec) -> execute (plan) -> verify (spec) -> finish (verify)

### Approval logic (`workflow-approval.test.ts` + `workflow-approval-edge.test.ts`)

48 tests total. Tests `runApprovalGate()` and `runUserApproval()`:

- **Mode: none** — auto-approves without UI
- **Mode: user** — Approve/Refine/Reject selection, refinement input, cancel at every step
- **Mode: agent** — reviewPrompt generation, reviewAgent setting (critic/reviewer), reviewCompleted flag
- **Mode: both** — agent review then user approval
- **Settings propagation** — per-phase isolation, runtime override/clearOverride, cross-phase non-interference
- **maxReviewRounds** — singular/plural text, all valid values (1-5)
- **Option text verification** — exact strings for Approve/Refine/Reject, Retry/Abandon
- **Edge cases** — undefined approval mode defaults, empty refinement, cancel flows, all 7 phases

### WorkflowCommand (`workflow-e2e.test.ts` + `workflow-commands-edge.test.ts`)

110 tests total. Tests every subcommand:

- **Command routing** — all 18 subcommands, unknown defaults to help, no subcommand shows status/help
- **Phase execution** — each phase returns correct prompt, activates correct phase, creates new session
- **Prerequisites** — each phase blocks when predecessor artifact missing, activePhases skips
- **#resolveSlug** — explicit slug, active fallback, UI input, cancel, empty string
- **#startBrainstorm** — empty topic (UI/non-UI), recursive input flow, startWorkflow action
- **#goBack** — explicit phase name, completed phases selector, no completed phases, non-UI usage message
- **#switchWorkflow** — no workflows (UI/non-UI), explicit slug, selector, cancel
- **#listWorkflows** — empty/non-empty (UI/non-UI), selector parse, null state handling
- **#showStatus / #showDetailedStatus** — markers (v/>/o/-), abandoned status, no active workflow
- **#checkPrereq** — activePhases filter, global settings enabled=false, missing artifact
- **#dispatchToPhase** — brainstorm re-entry (topic derived from slug), unknown phase error
- **#populateLocalSetup** — writes PHASE.md files, null artifactsDir early return, missing phases skipped
- **Management** — skip, abandon, delete (UI confirm/no-UI), rename (active update), list, resume, switch
- **info/infoError non-UI** — silent discard when hasUI=false
- **config** — no-UI error, UI calls custom()
- **Full pipeline** — walks all 7 phases in sequence

### Prompt templates (`workflow-prompts.test.ts`)

49 tests total. Tests `renderPromptTemplate()` with all 7 phase templates:

Per phase:
- Renders with all variables provided
- Optional variables (guarded by `#if`) omitted when missing
- Output contains `exit_plan_mode` instruction with correct title and workflowPhase
- Output contains phase-specific skill reference (brainstorming/spec-writing/architecture/planning/tdd/verification/finishing)
- Output contains workflow slug

General:
- Returns string (not null/undefined)
- Empty context doesn't throw (strict:false)
- Special characters pass through unescaped (noEscape:true)
- `propose_phases` mentioned only in brainstorm template

### Event contracts (`workflow-events.test.ts`)

56 tests total. Tests tool event contracts:

- **exit_plan_mode** — all 7 phases emit correct title and workflowPhase in prompt
- **propose_phases** — exclusive to brainstorm, absent from other 6 phases
- **Phase activation** — each phase calls `activateWorkflowPhase` with correct args
- **Session management** — each phase calls `newSession`, brainstorm via dispatch calls newSession
- **Data flow** — which artifacts each phase reads (spec reads brainstorm, design reads spec+brainstorm, etc.)
- **Conditional refs** — optional refs absent when artifact missing (design w/o brainstorm, plan w/o design, etc.)
- **Error handling** — missing prerequisites, missing slug, unknown phase
- **populateLocalSetup** — setup callback captured from newSession, writes correct files

### TUI components (`tui-workflow.test.ts` + `tui-workflow-advanced.test.ts`)

54 tests total. Tests with VirtualTerminal:

**HookSelectorComponent:**
- j/k navigation, Enter select, Escape cancel, Ctrl+C cancel
- Left/right arrow callbacks (onLeft/onRight)
- Boundary clamping (up at top, down at bottom)
- Scrolling with 20+ options, position counter
- Single option, empty options
- Countdown timer (auto-cancel on timeout, reset on keypress)
- Rapid keypresses

**HookInputComponent:**
- Character typing, Enter submit, Escape cancel
- Empty submit, backspace
- Long text input (200+ chars), special characters
- Countdown timer, reset on interaction

**WorkflowConfigComponent:**
- Renders all 7 phase headers, all 4 setting types
- Escape closes (calls done())
- Scope toggle (g key): session <-> global
- Navigation wraps (up at first -> last, down at last -> first)
- Setting cycle (Enter/Space): none->user->agent->both
- Reset override (r key): clears override in session scope
- r key no-op in global scope
- Hint text changes with scope
- Override marker (*) appears after change

### RPC E2E (`workflow-rpc-e2e.test.ts`)

7 tests, gated by `MINIMAX_CODE_API_KEY`:

- Basic connectivity — simple prompt round-trip
- Brainstorm phase — full flow with extension UI automation (auto-approve)
- Spec phase — with pre-seeded brainstorm artifact, prereqs pass
- Prerequisite enforcement — spec without brainstorm, notification error
- Info-only commands — list, status, delete via notification protocol

## Key infrastructure

### MockHookCommandContext (`workflow-harness.ts`)

Implements `HookCommandContext` with queued responses:

```typescript
const ctx = new MockHookCommandContext(tempDir);
ctx.ui.queueSelect("Approve");     // next select() returns "Approve"
ctx.ui.queueInput("fix the API");  // next input() returns "fix the API"

// After execution:
ctx.actions  // [{type: "activateWorkflowPhase", args: [...]}]
ctx.ui.calls // [{method: "select", args: [...]}, ...]
```

### Assertion helpers (`workflow-harness.ts`)

```typescript
await assertWorkflowState(cwd, slug, { currentPhase: "spec", slug });
await assertArtifactExists(cwd, slug, "brainstorm");
await assertArtifactMissing(cwd, slug, "spec");
await assertActiveWorkflow(cwd, "my-slug");
assertWorkflowDirContains(cwd, slug, ["state.json", "brainstorm.md"]);
```

### TUI test environment (`tui-harness.ts`)

```typescript
const env = await createTUITestEnv(80, 24);
const selector = new HookSelectorComponent(title, options, onSelect, onCancel);
env.root.addChild(selector);
env.tui.setFocus(selector);

await env.press("j");     // navigate down
await env.press("\n");     // select
const screen = await env.screen(); // viewport as string
env.dispose();
```

### Extension UI automation (RPC tests)

```typescript
const handler = createAutoApproveHandler();
const remove = attachExtensionUIHandler(client, handler);
// Handler auto-responds to approval dialogs
```

## Adding new tests

### New artifact function
Add to `workflow-artifacts.test.ts` (happy path) or `workflow-artifacts-edge.test.ts` (edge cases). Create temp dir in `beforeEach`, clean up in `afterEach`.

### New approval mode or flow
Add to `workflow-approval.test.ts` (basic) or `workflow-approval-edge.test.ts` (settings/edge cases). Use `Settings.init({ inMemory: true })` with overrides.

### New workflow command
Add to `workflow-e2e.test.ts` (routing) or `workflow-commands-edge.test.ts` (edge cases). Use `MockHookCommandContext`.

### New TUI component
Add to `tui-workflow.test.ts` (basics) or `tui-workflow-advanced.test.ts` (advanced). Use `createTUITestEnv()`.

### New prompt template
Add to `workflow-prompts.test.ts`. Import template with `{ type: "text" }`, verify variable substitution and content.

### New event contract
Add to `workflow-events.test.ts`. Verify prompt content instructs agent correctly, verify ctx.actions records correct calls.

### New RPC integration test
Add to `workflow-rpc-e2e.test.ts`. Gate with `describe.skipIf(!API_KEY)`. Use `collectUntilIdle()` for agent turns, `collectNotifications()` for info-only commands.

## What is NOT tested

- LLM output quality or correctness of generated content
- Visual appearance of TUI (behavior only, not pixels)
- Performance benchmarks
- Network connectivity or API authentication flows
- The `handleExitPlanModeTool` -> `#handleWorkflowPhaseComplete` chain in `interactive-mode.ts` (private methods, tested indirectly via RPC E2E brainstorm test)
