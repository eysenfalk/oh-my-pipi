# Agent-Loop to InteractiveMode Tool Execution Flow

## Overview
Complete chain: agent-loop.ts executeToolCalls() → ToolContextStore → ExtensionUIContext → tool.execute() → event stream → EventController → InteractiveMode handlers

## 1. Tool Execution Invocation (agent-loop.ts)

**File:** packages/agent/src/agent-loop.ts, line 430

**Function Signature:**
```typescript
async function executeToolCalls(
  tools: AgentTool<any>[] | undefined,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
  getToolContext?: AgentLoopConfig["getToolContext"],  // KEY PARAMETER
  interruptMode: AgentLoopConfig["interruptMode"] = "immediate",
  transformToolCallArguments?: AgentLoopConfig["transformToolCallArguments"],
  intentTracing?: AgentLoopConfig["intentTracing"],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }>
```

**Key Logic (line ~560-575):**
```typescript
// Get toolContext per tool call via callback
const toolContext = getToolContext
  ? getToolContext({
      batchId,
      index,
      total: toolCalls.length,
      toolCalls: toolCallInfos,
    })
  : undefined;

// Execute tool with context
result = await tool.execute(
  toolCall.id,
  args,
  signal,
  partialResultCallback,
  toolContext  // <-- PASSED HERE
);
```

## 2. ToolContextStore Setup (sdk.ts)

**File:** packages/coding-agent/src/sdk.ts, line 1410

Creates the store that provides context to tools:
```typescript
const toolContextStore = new ToolContextStore(getSessionContext);

// Set on agent constructor
getToolContext: tc => toolContextStore.getContext(tc),
```

**File:** packages/coding-agent/src/tools/context.ts, line 14

```typescript
export class ToolContextStore {
  #uiContext: ExtensionUIContext | undefined;
  #hasUI = false;
  #toolNames: string[] = [];

  constructor(private readonly getBaseContext: () => CustomToolContext) {}

  getContext(toolCall?: ToolCallContext): AgentToolContext {
    return {
      ...this.getBaseContext(),
      ui: this.#uiContext,        // <-- UI CALLBACKS
      hasUI: this.#hasUI,
      toolNames: this.#toolNames,
      toolCall,
    };
  }

  setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
    this.#uiContext = uiContext;
    this.#hasUI = hasUI;
  }
}
```

## 3. UI Context Creation & Storage (extension-ui-controller.ts)

**File:** packages/coding-agent/src/modes/controllers/extension-ui-controller.ts, line 30

Creates ExtensionUIContext with UI method implementations:
```typescript
const uiContext: ExtensionUIContext = {
  select: (title, options, dialogOptions) => this.showHookSelector(title, options, dialogOptions),
  confirm: (title, message, _dialogOptions) => this.showHookConfirm(title, message),
  input: (title, placeholder, dialogOptions) => this.showHookInput(title, placeholder, dialogOptions),
  notify: (message, type) => this.showHookNotify(message, type),
  setStatus: (key, text) => this.setHookStatus(key, text),
  setWorkingMessage: message => this.ctx.setWorkingMessage(message),
  // ... more UI methods
};

// Store in ToolContextStore via callback
this.ctx.setToolUIContext(uiContext, true);
```

## 4. Tool Uses Context (e.g., ask.ts)

**File:** packages/coding-agent/src/tools/ask.ts, line 409

Tools receive and use the context:
```typescript
async execute(
  _toolCallId: string,
  params: AskParams,
  signal?: AbortSignal,
  _onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
  context?: AgentToolContext,
): Promise<AgentToolResult<AskToolDetails>> {
  // Check if UI is available
  if (!context?.hasUI || !context.ui) {
    return { content: [{ type: "text", text: "Error: User prompt requires interactive mode" }] };
  }

  const extensionUi = context.ui;
  const selection = await extensionUi.select(prompt, options);
  // ... tool execution continues
}
```

## 5. Event Stream & Result Handling

**Agent emits tool_execution_end event:**
- packages/agent/src/agent-loop.ts, line ~500 (emitToolResult)
- AgentEvent: { type: "tool_execution_end", toolCallId, toolName, result, isError }

**Agent session forwards to listeners:**
- packages/coding-agent/src/session/agent-session.ts, line 1555
- Emits to EventController subscribers

## 6. Event Controller Routes to InteractiveMode (event-controller.ts)

**File:** packages/coding-agent/src/modes/controllers/event-controller.ts, line 407

```typescript
if (event.toolName === "exit_plan_mode" && !event.isError) {
  const details = event.result.details as ExitPlanModeDetails | undefined;
  if (details) {
    await this.ctx.handleExitPlanModeTool(details);  // <-- CALLS HERE
  }
}
```

Similar routing for other special tools:
- start_workflow → handleStartWorkflowTool()
- switch_workflow → handleSwitchWorkflowTool()
- propose_phases → setProposePhases()

## 7. InteractiveMode Handles Tool Completion (interactive-mode.ts)

**File:** packages/coding-agent/src/modes/interactive-mode.ts, line 815

```typescript
async handleExitPlanModeTool(details: ExitPlanModeDetails): Promise<void> {
  // Handle workflow phase completion
  if (details.workflowSlug && details.workflowPhase) {
    await this.#handleWorkflowPhaseComplete(details.workflowSlug, details.workflowPhase, details);
    return;
  }

  // Handle plan mode approval
  if (!this.planModeEnabled) {
    this.showWarning("Plan mode is not active.");
    return;
  }

  const planFilePath = details.planFilePath || this.planModePlanFilePath;
  const stageContent = await this.#readPlanFile(planFilePath);
  this.#renderPlanPreview(stageContent);
  await this.#handleFinalStageApproval(details, stageContent);
}
```

## AgentToolContext Module Augmentation

**File:** packages/coding-agent/src/tools/context.ts, line 6

TypeScript declaration merging extends the core AgentToolContext:
```typescript
declare module "@oh-my-pi/pi-agent-core" {
  interface AgentToolContext extends CustomToolContext {
    ui?: ExtensionUIContext;
    hasUI?: boolean;
    toolNames?: string[];
    toolCall?: ToolCallContext;
  }
}
```

This allows:
- Core agent-loop code (packages/agent) remains unaware of UI
- Coding agent extends AgentToolContext with UI and custom fields
- Tools access context.ui for interactive capabilities

## ToolCallContext Structure

**File:** packages/agent/src/types.ts, line 142

```typescript
export interface ToolCallContext {
  batchId: string;           // Unique batch identifier
  index: number;             // 0-based index in this batch
  total: number;             // Total calls in batch
  toolCalls: Array<{         // Metadata about all calls in batch
    id: string;
    name: string;
  }>;
}
```

Used for:
- Tracking concurrency/parallelization
- Providing context about batch execution
- Steering signal handling

## Tool Execution Features

**Concurrency Control:**
- `tool.concurrency?: "shared" | "exclusive"`
- "shared": runs parallel with other shared tools
- "exclusive": runs alone, others wait

**Nonabortable Tools:**
- `tool.nonAbortable?: boolean`
- If true, no AbortSignal passed; runs to completion

**Lenient Validation:**
- `tool.lenientArgValidation?: boolean`
- If true, raw args passed on validation error instead of failing

## Key Separation of Concerns

1. **packages/agent** (pi-agent-core):
   - Generic tool execution loop
   - No knowledge of UI or specific tools
   - Passes context callback (getToolContext) from config

2. **packages/coding-agent**:
   - Implements getToolContext via ToolContextStore
   - Creates ExtensionUIContext in controllers
   - Maps tool results to InteractiveMode handlers
   - Tools receive abstract ExtensionUIContext interface
   - Tools don't directly call InteractiveMode

3. **Tools themselves**:
   - Import AgentTool interface from pi-agent-core
   - Receive ExtensionUIContext via parameter context.ui
   - Can use context.ui.select(), context.ui.input(), etc.
   - Return details in result for special handling

## Exit Plan Mode Specific Flow

1. Agent decides to call exit_plan_mode tool
2. agent-loop.ts executeToolCalls() calls tool.execute()
3. Tool receives context with ExtensionUIContext
4. Tool returns result with ExitPlanModeDetails
5. Agent emits tool_execution_end event
6. EventController receives event
7. EventController calls InteractiveMode.handleExitPlanModeTool(details)
8. InteractiveMode shows approval UI, handles plan finalization
