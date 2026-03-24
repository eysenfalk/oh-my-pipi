# Oh My Pi Tool System Architecture

## Overview
The tool system is a two-tiered architecture:
1. **Base Tool Interface** (pi-ai package): Abstract definition with name, description, parameters
2. **AgentTool Interface** (agent-core package): Extends Tool with execute function, rendering, concurrency control
3. **Concrete Tool Implementations** (coding-agent package): Tool-specific logic for file operations, bash, Python, etc.

## Tool Definition Hierarchy

### Base: Tool<TParameters>
Location: `packages/ai/src/types.ts:394`
```
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  strict?: boolean;
}
```

### Extended: AgentTool<TParameters, TDetails, TTheme>
Location: `packages/agent/src/types.ts`
```
interface AgentTool<TParameters, TDetails, TTheme> extends Tool {
  label: string;
  hidden?: boolean;
  deferrable?: boolean;
  nonAbortable?: boolean;
  concurrency?: "shared" | "exclusive";
  lenientArgValidation?: boolean;
  execute: (toolCallId, params, signal?, onUpdate?, context?) => Promise<AgentToolResult>;
  renderCall?: (args, options, theme) => unknown;
  renderResult?: (result, options, theme) => unknown;
}
```

## Tool Registry & Creation

### Registry Pattern
Location: `packages/coding-agent/src/tools/index.ts`
- **BUILTIN_TOOLS**: 25+ standard tools (bash, read, write, grep, find, python, etc.)
- **HIDDEN_TOOLS**: 8 internal tools (submit_result, report_finding, exit_plan_mode, etc.)
- **Tool Factory**: `(session: ToolSession) => Tool | null | Promise<Tool | null>`

### Tool Creation Flow
1. `createTools(session, toolNames?)` - Main entry point
2. Validates tool availability via `isToolAllowed(name)` checks
3. Instantiates factories in parallel with logging
4. Auto-includes dependent tools (e.g., ast_grep with grep, ast_edit with edit)
5. Wraps all tools with `wrapToolWithMetaNotice()` middleware
6. Returns `Tool[]` ready for agent execution

### Tool Session Context
ToolSession provides:
- File system context (cwd, getSessionFile)
- UI and output capabilities (hasUI, allocateOutputArtifact)
- Service injections (asyncJobManager, mcpManager, internalRouter)
- Settings and state management (settings, getPlanModeState, etc.)
- Tool discovery (search_tool_bm25 integration)
- Checkpoint state management
- Compression tracking

## Tool Result Structure

### AgentToolResult<TDetails, TInput>
```
interface AgentToolResult<TDetails = any, TInput = unknown> {
  content: (TextContent | ImageContent)[];
  details?: TDetails;
}
```

### ToolResultBuilder (Fluent API)
Location: `packages/coding-agent/src/tools/tool-result.ts`
Provides chainable methods:
- `.text(string)` - Set text content
- `.content(ToolContent)` - Set raw content blocks
- `.truncation(result, options)` - Add truncation metadata
- `.limits(limits)` - Add limit information
- `.sourceUrl(value)` - Add URL source
- `.sourcePath(value)` - Add file path source
- `.sourceInternal(value)` - Add internal URL source
- `.diagnostics(summary, messages)` - Add LSP diagnostics
- `.done()` - Return AgentToolResult

## Tool Execution Pipeline

### Flow: Agent Loop → Tool Calls → Results → Messages
Location: `packages/agent/src/agent-loop.ts:executeToolCalls()`

1. **Tool Call Extraction**: Extract toolCall[] from assistant message
2. **Intent Extraction** (if enabled): Strip _i field from arguments
3. **Argument Transformation**: Apply optional transformToolCallArguments()
4. **Validation**: Call validateToolArguments() with lenient mode fallback
5. **Context Injection**: Build tool context if getToolContext() provided
6. **Tool.execute()** Invocation:
   - Pass: toolCallId, effectiveArgs, signal, onUpdate, context
   - Returns: AgentToolResult
   - On error: Wrapped in error result with message
7. **Result Wrapping**: Convert to ToolResultMessage
8. **Event Emission**: Push to EventStream for UI updates
9. **Context Update**: Add ToolResultMessage to messages[]

### Concurrency Control
- **shared** (default): Can run parallel with other shared tools
- **exclusive**: Blocks other tools until completion
- Implemented via Promise sequencing in executeToolCalls()

### Interruption Points
- **immediate** (default): Check steering messages after each tool
- **wait**: Defer steering until turn completes
- Steering messages abort remaining tool calls in batch

## Tool Middleware & Hooks

### OutputMeta Wrapper
Location: `packages/coding-agent/src/tools/output-meta.ts:wrapToolWithMetaNotice()`
- Wraps tool.execute() without modifying signature
- Captures OutputMeta from details.meta
- Appends formatted notices to output (truncation, limits, diagnostics)
- Maintains kUnwrappedExecute symbol for identity checks

### Tool Errors
Location: `packages/coding-agent/src/tools/tool-errors.ts`
- **ToolError**: Base error with custom render() for LLM formatting
- **ToolAbortError**: Signals cancellation (distinct from failures)
- **throwIfAborted()**: Standardized abort check

### Tool Sessions Validation
- Python availability checks (kernel startup, environment setup)
- Tool setting guards (settings.get("tool.enabled"))
- Task recursion depth limits
- LSP integration enablement
- Feature flags per session

## Tool Discovery & Selection

### Standard Tool List (BUILTIN_TOOLS)
1. ast_grep - Syntax-aware code search
2. ast_edit - Syntax-aware file editing
3. render_mermaid - Mermaid diagram rendering
4. ask - User interaction
5. bash - Shell command execution
6. python - Python REPL execution
7. calc - Calculator
8. ssh - SSH connection
9. edit - Text file patching
10. find - File search
11. grep - Text search
12. lsp - Language server integration
13. notebook - Jupyter notebook interface
14. read - File reading with formatting
15. inspect_image - Image metadata extraction
16. browser - Browser automation
17. checkpoint/rewind - Session checkpointing
18. task - Subagent invocation
19. cancel_job - Background job management
20. await - Job polling
21. todo_write - To-do management
22. fetch - HTTP requests
23. web_search - Web search
24. search_tool_bm25 - MCP tool discovery
25. write - File writing
26. compress - Context compression

### Hidden Tools (HIDDEN_TOOLS)
1. submit_result - Final result submission
2. report_finding - Finding reporting
3. exit_plan_mode - Plan mode exit
4. resolve - Deferred action resolution
5. propose_phases - Phase proposal
6. start_workflow - Workflow start
7. switch_workflow - Workflow switching

## Configuration & Customization

### Python Tool Mode
Environment variable: PI_PY
- "0"/"bash" → bash-only
- "1"/"py" → ipy-only
- "mix"/"both" → both

### Intent Tracing
- Feature flag: config.intentTracing
- Automatically injects _i field into tool schemas
- Strips _i before tool.execute() invocation
- Stores intent in ToolExecutionEvent for auditing

### Tool Features
- **deferrable**: Tool can defer action and require explicit resolve
- **hidden**: Tool not shown in standard listings
- **nonAbortable**: Tool continues despite AbortSignal
- **lenientArgValidation**: Pass raw args if validation fails
- **concurrency**: Execution scheduling (shared/exclusive)

## Tool Message Integration

### ToolResultMessage Structure
```
{
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

### Message Flow
1. User message → Assistant message (with tool calls)
2. Tool calls → Execute in parallel/sequential order
3. Tool results → ToolResultMessage[]
4. Add to context → Next agent turn

## Key Files Reference
- Tool registry: packages/coding-agent/src/tools/index.ts
- Types: packages/agent/src/types.ts (AgentTool), packages/ai/src/types.ts (Tool)
- Loop: packages/agent/src/agent-loop.ts (executeToolCalls)
- Result builder: packages/coding-agent/src/tools/tool-result.ts
- Error handling: packages/coding-agent/src/tools/tool-errors.ts
- Output metadata: packages/coding-agent/src/tools/output-meta.ts
- Tool session: packages/coding-agent/src/tools/index.ts (ToolSession interface)
