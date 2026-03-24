# Workflow docs + /workflow return-value fix

**Goal:** Fix `/workflow` informational commands leaking text to the agent, add `/workflow help`, write user + technical documentation.

**Slug:** `2026-03-24-workflow-docs`
**Phases:** plan, execute, verify

---

## File map

```
MODIFY: packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts
CREATE: docs/workflow.md
```

---

## Task 1: Fix return values + add /workflow help

**Agent tier:** `task`
**File:** `packages/coding-agent/src/extensibility/custom-commands/bundled/workflow/index.ts`

### Problem

`CustomCommand.execute()` returns `string | undefined`. When it returns a string, `AgentSession.#tryExecuteCustomCommand` at line 2326 does `text = customResult` — the string becomes a user message sent to the LLM. This is correct for phase-start prompts (the returned `renderPromptTemplate(...)` IS a prompt for the agent). But it's wrong for informational output like help text, status, and confirmation messages — those get sent to the agent as if the user typed them.

### Commands that incorrectly return strings to agent

| Method | Returns | Should |
|---|---|---|
| `#showStatus` | workflow status text | notify + undefined |
| `#showHelp` | help text | notify + undefined |
| `#showDetailedStatus` | phase overview | notify + undefined |
| `#deleteWorkflow` | "Workflow deleted" | notify + undefined |
| `#renameWorkflow` | "Workflow renamed" | notify + undefined |
| `#skipPhase` | "Phase marked as skipped" | notify + undefined |
| `#abandonWorkflow` | "Workflow marked as abandoned" | notify + undefined |
| `#listWorkflows` (non-UI) | workflow listing | notify + undefined |
| Error messages (various) | "No workflow found" etc. | notify(error) + undefined |

### Commands that correctly return prompt strings

| Method | Returns |
|---|---|
| `#startSpec`, `#startDesign`, etc. | `renderPromptTemplate(...)` — agent prompt |
| `#startBrainstorm` | undefined (delegates to ctx.startWorkflow) |

### Fix

Add a helper method to display informational text:

```typescript
#info(ctx: HookCommandContext, message: string): undefined {
    if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
    }
    return undefined;
}

#infoError(ctx: HookCommandContext, message: string): undefined {
    if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
    }
    return undefined;
}
```

Then change all informational returns from `return "message"` to `return this.#info(ctx, "message")`.

For `#showHelp` and `#showDetailedStatus`, these return multi-line text. Use `ctx.ui.notify()` for simple messages and for multi-line output, just show the text in the status area. Actually, `notify` works fine for multi-line — it shows a brief notification. For the help text and detailed status, these are longer — use `ctx.ui.setStatus("workflow", text)` or just notify. The simplest approach: all informational returns go through notify.

For methods that have both error paths (returning error strings) AND prompt paths (returning renderPromptTemplate), each error return needs to be changed to `this.#infoError(ctx, ...)`.

### `/workflow help` subcommand

Add `case "help":` to the execute switch, pointing to the same `#showHelp` method. Update `#showHelp` to use the `#info` helper.

### No-arg `/workflow` behavior

When no subcommand: show status if active workflow exists, otherwise show help. Both should use `#info` — not return the string.

---

## Task 2: Write documentation

**Agent tier:** `task`
**File:** `docs/workflow.md`

Write a single comprehensive document covering:

1. **User guide** — what the workflow is, when to use it, all commands with examples
2. **Technical reference** — architecture, file structure, state model, how phases/approval work

The document lives at `docs/workflow.md` and should be the canonical reference for the workflow feature.

---

## Verification

- `bun check:ts` clean
- `/workflow` (no args) does not send text to the agent
- `/workflow help` shows help without sending to agent
- `/workflow status` shows status without sending to agent
- `/workflow delete <slug>` shows confirmation message without sending to agent
- Documentation covers all commands and the full lifecycle
