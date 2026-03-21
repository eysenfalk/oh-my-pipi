# Anthropic Message Conversion Investigation

## Task
Map how AgentMessage[] gets converted to Anthropic API format in `packages/ai/src/providers/anthropic.ts`

## Key Function: convertAnthropicMessages()
**Location**: `packages/ai/src/providers/anthropic.ts` lines 1008–1139

**Signature**:
```ts
export function convertAnthropicMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthToken: boolean,
): MessageParam[]
```

**Flow**:
1. Calls `transformMessages(messages, model, normalizeToolCallId)` first (from transform-messages.ts)
2. Iterates transformed messages and converts each by role

## Conversion by Role

### User/Developer Messages (lines 1022–1047)
- Skipped if content empty
- If content is string: pushed as-is (UTF-8 normalized)
- If content is array: converted to content blocks (text/image)
- Images filtered out if model doesn't support them
- Empty text blocks filtered out
- Result: single user-role message with all blocks

### Assistant Messages (lines 1048–1091)
- Thinking blocks: preserved with signature if present; converted to text if no signature
- RedactedThinking blocks: preserved as-is
- Text blocks: converted to text content blocks
- ToolCall blocks: converted to tool_use blocks (with prefix applied for OAuth)
- Skipped if no blocks remain
- Result: single assistant-role message

### ToolResult Messages (lines 1092–1118)
- **BATCHES consecutive toolResult messages** (look-ahead from line 1105)
- All results collected into single user-role message (not separate results)
- Content: tool_result blocks with tool_use_id, content (text/images), and is_error flag
- Skips ahead past consecutive tool results (`i = j - 1`)

### Post-Processing (lines 1120–1122)
- **If last message is assistant**: injects `{ role: "user", content: "Continue." }`
- Ensures message alternation constraint (no two consecutive assistants)

## How Tool Results Are Formatted
- **Grouped**: All consecutive toolResult messages batched into ONE user message
- **Format**: Each becomes a `tool_result` content block
- **Content**: via `convertContentBlocks()` (text or mixed text+images)
- **Error flag**: `is_error` boolean preserved
- **Role**: Always converted to "user" (required by Anthropic API)

## Message Merge Behavior
- **Consecutive same-role messages**: NOT explicitly merged; but
- **Tool results**: Explicitly batched (consecutive toolResult → single user message)
- **Final assistant guard**: If last is assistant, injects user "Continue." to prevent consecutive assistants

## Thinking Block Handling
- **Preserved**: If thinking block has signature (signed by Anthropic), kept as-is
- **Converted to text**: If thinking block has no signature and not latest message, converted to plain text
- **Logic**: 
  - For latest Anthropic message: preserves as thinking block (line 1055-1060)
  - For same-model non-latest: kept as thinking if signed (line 1062)
  - For different model non-latest: converted to text (lines 1063-1065)

## Validation of Message Alternation
- **Explicit check** (line 1121): `if (params[params.length - 1]?.role === "assistant")`
- **Action**: Injects `{ role: "user", content: "Continue." }` to break consecutive assistants
- **Why**: Anthropic API strictly requires alternating user/assistant (each assistant must be followed by user)

## Key Insights from Code
1. **Tool result batching** happens during conversion (not before)
2. **Thinking signature preservation** is model-aware (different rules for latest vs same-model vs different-model)
3. **Consecutive assistant guard** only added after conversion (reactive, not proactive)
4. **Role conversion**: toolResult always → user; never stays as tool-specific role
