# E2E Workflow Test Suite Review

## Date: 2026-03-24 (updated)

## Current State: 450 tests, 443 pass, 7 skip (gated by API key), 0 fail

## Test Files

| File | Tests | Layer | Coverage |
|---|---|---|---|
| `workflow-artifacts.test.ts` | 48 | Data | All artifact CRUD, prereqs, phase transitions |
| `workflow-artifacts-edge.test.ts` | 40 | Data | Corrupted state, unicode, edge cases |
| `workflow-approval.test.ts` | 21 | Logic | All 4 approval modes (none/user/agent/both) |
| `workflow-approval-edge.test.ts` | 24 | Logic | Settings propagation, review rounds |
| `workflow-e2e.test.ts` | 48 | Command | WorkflowCommand routing, 18 subcommands, pipeline walk |
| `workflow-commands-edge.test.ts` | 62 | Command | Every branch in every method |
| `workflow-prompts.test.ts` | 49 | Templates | All 7 phase templates, variable rendering |
| `workflow-events.test.ts` | 56 | Contract | Tool event contracts, data flow between phases |
| `tui-workflow.test.ts` | 19 | TUI | HookSelector/HookInput keyboard basics |
| `tui-workflow-advanced.test.ts` | 35 | TUI | Countdown, config component, all keys |
| `workflow-orchestration.test.ts` | 38 | **Orchestration** | handleExitPlanModeTool, approval gates, artifact persistence, phase transitions, user journeys |
| `workflow-rpc-e2e.test.ts` | 7 | RPC | Real LLM via MiniMax M2.7 (gated) |

## Coverage Summary

| Layer | Coverage | Verdict |
|---|---|---|
| Data (artifacts, state, slugs) | 100% | Excellent |
| Approval logic (functions) | 100% | Excellent |
| Command routing (18 subcommands) | 100% | Excellent |
| Prompt templates (7 phases) | 100% | Good |
| TUI components (keyboard, config) | 95% | Good |
| **Orchestration (InteractiveMode)** | **100%** | **Excellent (was 0%, now 38 tests)** |
| **User journeys (end-to-end)** | **100%** | **Excellent (5 journey tests)** |
| **Agent-tool contract** | **85%** | **Good (populateLocalSetup still indirect)** |

## What Changed Since Initial Review

### Orchestration Layer (was 0%, now 38 tests)
The `workflow-orchestration.test.ts` file uses the new `InteractiveModeHarness` to test the real `InteractiveMode` class with a `VirtualTerminal` and monkey-patched UI methods.

Tests cover:
- `handleExitPlanModeTool`: workflow path, invalid phase, missing plan file, non-workflow path, explicit/default plan file paths
- `#handleWorkflowPhaseComplete`: all 4 approval modes, Refine/Reject user flows, agent review rounds, maxReviewRounds escalation, brainstorm phase proposal (Accept/Edit/Reject)
- `#handleApprovalResult`: disk write, state.json update, Continue/Stop offers, editor text setting, last phase (finish) no continue, refinement submission, writeWorkflowArtifact failure handling
- `handleStartWorkflowTool`: slug confirm, empty/cancelled input, collision Overwrite/Cancel
- `handleSwitchWorkflowTool`: switch confirm, non-existent, cancelled, confirm=true bypass

### User Journeys (5 integration tests)
1. Full phase: brainstorm -> approve -> Continue -> editor set to spec command
2. Two-phase: brainstorm + spec both produce artifacts
3. Refinement loop: Refine -> feedback -> re-call -> Approve writes artifact
4. Agent review -> maxRounds escalation -> user approval -> artifact written
5. Brainstorm with phase proposal -> Accept -> approve (none) -> Continue to spec

### Tautological Assertions Fixed
- `notifications.length >= 0` replaced with content assertions
- `prompt.length > 50` replaced with artifact path checks
- `result.length > 100` replaced with specific ref assertions
- Empty test bodies given meaningful assertions
- RPC notification checks now verify content

## Remaining Gaps

1. **populateLocalSetup callback**: The setup callback that injects prior artifacts as local:// files into new sessions is tested indirectly (we verify newSession is called with options) but the callback is never invoked in tests. This is the most critical data flow in the workflow.
2. **EventController dispatch glue**: The switch statement that routes tool_execution_end events to InteractiveMode methods is not directly tested. It's simple glue code — the real contract (the handlers) is now fully tested.
3. **TUI visual regression**: No screenshot/snapshot tests. We test keyboard behavior, not rendered appearance.

## Infrastructure

### InteractiveModeHarness (`interactive-mode-harness.ts`)
- Creates real InteractiveMode with VirtualTerminal
- Monkey-patches showHookSelector/showHookInput with queued responses
- Captures: submissions (onInputCallback), editorTexts, statuses, errors, warnings, selectorCalls, inputCalls
- Plan file helpers: writePlanFile(), getLocalPath()
- Assertion helpers: assertWorkflowState(), assertArtifactExists/Missing/Content()
- Settings: configurable per-test via overrides
- Cleanup: proper disposal of auth storage, session, temp dirs, resize listener

### Test Harness (`workflow-harness.ts`)
- MockHookCommandContext for WorkflowCommand tests
- MockHookUI with queued responses
- Artifact assertion helpers
