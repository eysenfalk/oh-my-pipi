# E2E Test Framework

End-to-end integration tests for the OMP workflow system. Tests the full orchestration layer: phase ordering, artifact I/O, data flow, command routing, settings propagation, approval gates, and TUI wiring.

## Architecture

### Three test layers

| Layer | Tests | Runtime | LLM | CI |
|---|---|---|---|---|
| **Artifact/Approval** | State machine, file I/O, prerequisites, approval logic | ~200ms | None | Always |
| **TUI Wiring** | Keyboard navigation, selector/input components, approval flows | ~500ms | None | Always |
| **RPC E2E** | Full workflow via RPC protocol with real LLM | 60-240s/test | MiniMax M2.7 | Gated |

### File layout

```
test/e2e/
  workflow-artifacts.test.ts   # 48 tests — artifact function coverage
  workflow-approval.test.ts    # 21 tests — approval gate logic
  workflow-e2e.test.ts         # 48 tests — WorkflowCommand routing + pipeline
  workflow-rpc-e2e.test.ts     #  7 tests — real LLM via RPC (gated)
  tui-workflow.test.ts         # 19 tests — TUI component wiring
  workflow-harness.ts          # MockHookCommandContext, assertion helpers
  tui-harness.ts               # VirtualTerminal TUI environment
```

## Running tests

```bash
# All deterministic tests (no API key needed)
cd packages/coding-agent && bun test test/e2e/

# Specific layer
bun test test/e2e/workflow-artifacts.test.ts
bun test test/e2e/tui-workflow.test.ts

# RPC E2E (requires MiniMax API key)
MINIMAX_CODE_API_KEY=sk-... bun test test/e2e/workflow-rpc-e2e.test.ts

# All E2E via package script
bun run test:e2e
```

## Test layers in detail

### Artifact tests (`workflow-artifacts.test.ts`)

Direct imports of functions from `artifacts.ts`. Each test creates a temp directory and exercises a single function:

- `writeWorkflowArtifact` — state.json creation, updates, phase.md writes
- `readWorkflowState` / `readWorkflowArtifact` — read back, ENOENT handling, validation
- `createWorkflowState` — initial state structure, activePhases
- `getNextPhase` — sequential walk, activePhases filtering, end-of-workflow
- `listWorkflows` — directory listing, sort order
- `generateSlug` — date prefix, sanitization, max length
- `formatWorkflowStatus` — human-readable output
- `setActiveWorkflowSlug` / `getActiveWorkflowSlug` / `findActiveWorkflow` — .active file
- `updateWorkflowActivePhases` — phase filter updates
- `persistPhaseLearnings` — learnings.md append
- **Phase prerequisites** — verifies the full chain: brainstorm (none) -> spec (brainstorm) -> design (spec) -> plan (spec) -> execute (plan) -> verify (spec) -> finish (verify)

### Approval tests (`workflow-approval.test.ts`)

Tests `runApprovalGate()` and `runUserApproval()` with a mock `ApprovalContext`:

- **Mode: none** — auto-approves without calling context
- **Mode: user** — Approve/Refine/Reject selection flows, refinement input
- **Mode: agent** — returns reviewPrompt on first pass, approves when reviewCompleted
- **Mode: both** — combines agent review then user approval
- Settings propagation via `Settings.isolated()`

### WorkflowCommand E2E tests (`workflow-e2e.test.ts`)

Tests the `WorkflowCommand` class directly with `MockHookCommandContext`:

- **Command routing** — all 18 subcommands dispatch correctly
- **Phase execution** — each phase returns correct prompt, activates correct phase
- **Prerequisites** — each phase blocks when predecessor artifact missing
- **Management** — skip, abandon, delete, rename, list, resume, switch, status
- **Full pipeline** — walks all 7 phases in sequence, verifying state after each
- **Data flow** — verifies prompts reference correct predecessor artifacts

### TUI wiring tests (`tui-workflow.test.ts`)

Tests `HookSelectorComponent` and `HookInputComponent` with VirtualTerminal:

- **Selector keyboard** — j/k navigation, Enter select, Escape cancel, bounds clamping
- **Selector rendering** — title and options visible in viewport, scrolling with many options
- **Input keyboard** — character typing, Enter submit, Escape cancel, empty submit
- **Input rendering** — title and help text visible
- **Approval flows** — multi-step: Approve -> Continue, Refine -> type feedback, Reject -> Retry

### RPC E2E tests (`workflow-rpc-e2e.test.ts`)

Spawns real agent process via `RpcClient`, connects to MiniMax M2.7 LLM:

- **Basic connectivity** — simple prompt round-trip
- **Brainstorm phase** — full brainstorm flow with extension UI automation (auto-approve)
- **Spec phase** — with pre-seeded brainstorm artifact, verifies prereqs pass
- **Prerequisite enforcement** — spec without brainstorm, verifies notification error
- **Info-only commands** — list, status, delete via notification protocol (not agent turns)

Gated by `MINIMAX_CODE_API_KEY` environment variable.

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
// Handler auto-responds to approval dialogs:
// - "Approve" when available
// - "Accept" for phase proposals
// - "Continue" for next-phase dialogs
// - Placeholder value for input dialogs
```

## Adding new tests

### New artifact function

Add to `workflow-artifacts.test.ts`. Create temp dir in `beforeEach`, clean up in `afterEach`. Test happy path, error path (ENOENT), and edge cases.

### New approval mode or flow

Add to `workflow-approval.test.ts`. Use `Settings.isolated()` with overrides. Mock the `ApprovalContext` via `MockHookUI`.

### New workflow command

Add to `workflow-e2e.test.ts`. Create a `MockHookCommandContext`, pre-seed any required workflow state, execute the command, assert on `ctx.actions` and `ctx.ui.calls`.

### New TUI component

Add to `tui-workflow.test.ts`. Use `createTUITestEnv()`, add component to `env.root`, set focus, send keystrokes with `env.press()`, assert on callbacks or `env.screen()`.

### New RPC integration test

Add to `workflow-rpc-e2e.test.ts`. Gate with `describe.skipIf(!API_KEY)`. For commands that start agent turns, use `collectUntilIdle()`. For info-only commands, use `collectNotifications()`. Use `attachExtensionUIHandler()` to automate approval dialogs.

## RpcClient extension UI support

Added for E2E testing automation:

```typescript
// Subscribe to extension UI requests (approval dialogs, selectors, inputs)
const remove = client.onExtensionUIRequest((request) => {
  // request.method: "select" | "confirm" | "input" | "notify" | ...
  // request.id, request.options, request.title, etc.
});

// Send response (fire-and-forget, no RPC response expected)
client.sendExtensionUIResponse({ id: request.id, value: "Approve" });
```

## What is NOT tested

- LLM output quality or correctness of generated content
- Visual appearance of TUI (behavior only, not pixels)
- Performance benchmarks
- Network connectivity or API authentication flows
- The `handleExitPlanModeTool` -> `#handleWorkflowPhaseComplete` chain in `interactive-mode.ts` (private methods, tested indirectly via RPC E2E)
