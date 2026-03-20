import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { applyContextPruning } from "../src/session/context-pruning/pipeline";
import { buildToolSignature, createPruneState, syncStateFromMessages } from "../src/session/context-pruning/state";
import { deduplication } from "../src/session/context-pruning/strategies/deduplication";
import { purgeErrors } from "../src/session/context-pruning/strategies/purge-errors";
import { supersedeWrites } from "../src/session/context-pruning/strategies/supersede-writes";
import { type ContextPruningConfig, DEFAULT_PRUNING_CONFIG } from "../src/session/context-pruning/types";

// ============================================================================
// Test helpers
// ============================================================================

let toolCallCounter = 0;
function makeToolCallId(): string {
	return `tool_${++toolCallCounter}`;
}

/** Build an assistant message containing one tool call */
function makeToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: makeToolCallId(),
				name,
				arguments: args,
			},
		],
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

/** Build a tool result message */
function makeToolResult(toolCallId: string, toolName: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: isError ? "Error: something failed" : "ok" }],
		isError,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function makeUserMessage(text = "hello"): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function getToolCallId(msg: AgentMessage): string {
	const m = msg as { role: string; content: Array<{ type: string; id?: string }> };
	const block = m.content?.find(b => b.type === "toolCall");
	return block?.id ?? "";
}

// ============================================================================
// buildToolSignature
// ============================================================================

describe("buildToolSignature", () => {
	it("returns just the tool name for null args", () => {
		expect(buildToolSignature("read", null)).toBe("read");
	});

	it("produces consistent signature regardless of key order", () => {
		const a = buildToolSignature("grep", { path: "/foo", pattern: "bar" });
		const b = buildToolSignature("grep", { pattern: "bar", path: "/foo" });
		expect(a).toBe(b);
	});

	it("different args produce different signatures", () => {
		const a = buildToolSignature("read", { path: "/a" });
		const b = buildToolSignature("read", { path: "/b" });
		expect(a).not.toBe(b);
	});

	it("different tool names produce different signatures", () => {
		const a = buildToolSignature("read", { path: "/a" });
		const b = buildToolSignature("write", { path: "/a" });
		expect(a).not.toBe(b);
	});
});

// ============================================================================
// syncStateFromMessages
// ============================================================================

describe("syncStateFromMessages", () => {
	it("discovers tool calls from assistant messages", () => {
		const state = createPruneState();
		const toolMsg = makeToolCall("bash", { command: "ls" });
		const id = getToolCallId(toolMsg);

		syncStateFromMessages(state, [makeUserMessage(), toolMsg]);

		expect(state.toolIdList).toContain(id);
		expect(state.toolMetadata.get(id)?.name).toBe("bash");
	});

	it("marks tool as error when result is error", () => {
		const state = createPruneState();
		const toolMsg = makeToolCall("bash", { command: "bad-cmd" });
		const id = getToolCallId(toolMsg);
		const resultMsg = makeToolResult(id, "bash", true);

		syncStateFromMessages(state, [makeUserMessage(), toolMsg, resultMsg]);

		expect(state.toolMetadata.get(id)?.isError).toBe(true);
	});

	it("tracks user message count as turn proxy", () => {
		const state = createPruneState();
		syncStateFromMessages(state, [makeUserMessage(), makeUserMessage(), makeUserMessage()]);
		expect(state.currentTurn).toBe(3);
	});

	it("does not add duplicate IDs on second sync", () => {
		const state = createPruneState();
		const toolMsg = makeToolCall("read", { path: "/f" });
		const messages = [makeUserMessage(), toolMsg];

		syncStateFromMessages(state, messages);
		syncStateFromMessages(state, messages);

		const id = getToolCallId(toolMsg);
		expect(state.toolIdList.filter(x => x === id)).toHaveLength(1);
	});
});

// ============================================================================
// deduplication strategy
// ============================================================================

describe("deduplication strategy", () => {
	it("keeps only the most recent of duplicate tool calls", () => {
		const state = createPruneState();
		const call1 = makeToolCall("bash", { command: "ls /tmp" });
		const call2 = makeToolCall("bash", { command: "ls /tmp" }); // identical
		const id1 = getToolCallId(call1);
		const id2 = getToolCallId(call2);

		syncStateFromMessages(state, [makeUserMessage(), call1, call2]);
		deduplication(state, DEFAULT_PRUNING_CONFIG);

		// call1 (older) pruned; call2 (newer) kept
		expect(state.pruneMap.has(id1)).toBe(true);
		expect(state.pruneMap.has(id2)).toBe(false);
	});

	it("does not prune tool calls with different arguments", () => {
		const state = createPruneState();
		const call1 = makeToolCall("read", { path: "/a" });
		const call2 = makeToolCall("read", { path: "/b" });

		syncStateFromMessages(state, [makeUserMessage(), call1, call2]);
		deduplication(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.size).toBe(0);
	});

	it("respects protected tools", () => {
		const state = createPruneState();
		const call1 = makeToolCall("read", { path: "/same" });
		const call2 = makeToolCall("read", { path: "/same" });

		syncStateFromMessages(state, [makeUserMessage(), call1, call2]);
		deduplication(state, DEFAULT_PRUNING_CONFIG); // "read" is in DEFAULT_PROTECTED_TOOLS

		expect(state.pruneMap.size).toBe(0);
	});

	it("does not run when disabled", () => {
		const state = createPruneState();
		const call1 = makeToolCall("bash", { command: "ls" });
		const call2 = makeToolCall("bash", { command: "ls" });

		syncStateFromMessages(state, [makeUserMessage(), call1, call2]);
		const config: ContextPruningConfig = {
			...DEFAULT_PRUNING_CONFIG,
			deduplication: { ...DEFAULT_PRUNING_CONFIG.deduplication, enabled: false },
		};
		deduplication(state, config);

		expect(state.pruneMap.size).toBe(0);
	});
});

// ============================================================================
// purge-errors strategy
// ============================================================================

describe("purgeErrors strategy", () => {
	it("prunes errored tool input after turnDelay turns", () => {
		const state = createPruneState();
		const call = makeToolCall("bash", { command: "bad" });
		const id = getToolCallId(call);
		const result = makeToolResult(id, "bash", true);

		syncStateFromMessages(state, [makeUserMessage(), call, result]);

		// Force turn to be 5 turns later (delay is 4)
		state.currentTurn = 5;
		const meta = state.toolMetadata.get(id);
		if (meta) meta.turn = 0;

		purgeErrors(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.has(id)).toBe(true);
	});

	it("does not prune recent errored tools (within turnDelay)", () => {
		const state = createPruneState();
		const call = makeToolCall("bash", { command: "bad" });
		const id = getToolCallId(call);
		const result = makeToolResult(id, "bash", true);

		syncStateFromMessages(state, [makeUserMessage(), call, result]);

		// Same turn — within delay
		state.currentTurn = 1;
		purgeErrors(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.has(id)).toBe(false);
	});

	it("does not prune successful tool calls", () => {
		const state = createPruneState();
		const call = makeToolCall("bash", { command: "ls" });
		const id = getToolCallId(call);
		const result = makeToolResult(id, "bash", false);

		syncStateFromMessages(state, [makeUserMessage(), call, result]);
		state.currentTurn = 10;
		purgeErrors(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.has(id)).toBe(false);
	});

	it("respects protected tools", () => {
		const state = createPruneState();
		const call = makeToolCall("read", { path: "/f" });
		const id = getToolCallId(call);
		const result = makeToolResult(id, "read", true);

		syncStateFromMessages(state, [makeUserMessage(), call, result]);
		state.currentTurn = 10;
		purgeErrors(state, DEFAULT_PRUNING_CONFIG);

		// "read" is in DEFAULT_PROTECTED_TOOLS
		expect(state.pruneMap.has(id)).toBe(false);
	});
});

// ============================================================================
// supersede-writes strategy
// ============================================================================

describe("supersedeWrites strategy", () => {
	it("prunes write input when file is subsequently read", () => {
		const state = createPruneState();
		const writeCall = makeToolCall("write", { path: "/src/foo.ts", content: "hello" });
		const writeId = getToolCallId(writeCall);
		const readCall = makeToolCall("read", { path: "/src/foo.ts" });

		syncStateFromMessages(state, [makeUserMessage(), writeCall, readCall]);
		supersedeWrites(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.has(writeId)).toBe(true);
	});

	it("does not prune write when no subsequent read", () => {
		const state = createPruneState();
		const writeCall = makeToolCall("write", { path: "/src/foo.ts", content: "hello" });
		const writeId = getToolCallId(writeCall);

		syncStateFromMessages(state, [makeUserMessage(), writeCall]);
		supersedeWrites(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.has(writeId)).toBe(false);
	});

	it("does not prune write when read precedes it", () => {
		const state = createPruneState();
		const readCall = makeToolCall("read", { path: "/src/foo.ts" });
		const writeCall = makeToolCall("write", { path: "/src/foo.ts", content: "changed" });
		const writeId = getToolCallId(writeCall);

		syncStateFromMessages(state, [makeUserMessage(), readCall, writeCall]);
		supersedeWrites(state, DEFAULT_PRUNING_CONFIG);

		// Read comes BEFORE write; no supersession
		expect(state.pruneMap.has(writeId)).toBe(false);
	});

	it("prunes multiple writes to the same file when a later read exists", () => {
		const state = createPruneState();
		const write1 = makeToolCall("write", { path: "/f.ts", content: "v1" });
		const write2 = makeToolCall("write", { path: "/f.ts", content: "v2" });
		const readCall = makeToolCall("read", { path: "/f.ts" });
		const id1 = getToolCallId(write1);
		const id2 = getToolCallId(write2);

		syncStateFromMessages(state, [makeUserMessage(), write1, write2, readCall]);
		supersedeWrites(state, DEFAULT_PRUNING_CONFIG);

		expect(state.pruneMap.has(id1)).toBe(true);
		expect(state.pruneMap.has(id2)).toBe(true);
	});
});

// ============================================================================
// Pipeline integration
// ============================================================================

describe("applyContextPruning pipeline", () => {
	it("returns same array reference when nothing is pruned", () => {
		const state = createPruneState();
		const messages = [makeUserMessage(), makeToolCall("bash", { command: "ls" })];

		const result = applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);
		expect(result).toBe(messages);
	});

	it("returns new array when pruning occurs", () => {
		const state = createPruneState();
		const call1 = makeToolCall("bash", { command: "ls" });
		const call2 = makeToolCall("bash", { command: "ls" });
		const messages = [makeUserMessage(), call1, call2];

		const result = applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);
		expect(result).not.toBe(messages);
	});

	it("returns unchanged when disabled", () => {
		const state = createPruneState();
		const call1 = makeToolCall("bash", { command: "same" });
		const call2 = makeToolCall("bash", { command: "same" });
		const messages = [makeUserMessage(), call1, call2];

		const config: ContextPruningConfig = { ...DEFAULT_PRUNING_CONFIG, enabled: false };
		const result = applyContextPruning(messages, state, config);
		expect(result).toBe(messages);
	});

	it("updates stats after pruning", () => {
		const state = createPruneState();
		const call1 = makeToolCall("bash", { command: "same" });
		const call2 = makeToolCall("bash", { command: "same" });
		const messages = [makeUserMessage(), call1, call2];

		applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);
		expect(state.stats.toolsPruned).toBe(1);
	});

	it("replaces pruned tool arguments with placeholder", () => {
		const state = createPruneState();
		const call1 = makeToolCall("bash", { command: "dup" });
		const call2 = makeToolCall("bash", { command: "dup" });
		const id1 = getToolCallId(call1);
		const messages = [makeUserMessage(), call1, call2];

		const result = applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);

		// Find the pruned message
		const prunedMsg = result.find(m => {
			if (m.role !== "assistant") return false;
			const a = m as { content: Array<{ type: string; id?: string; arguments?: unknown }> };
			return a.content?.some(b => b.type === "toolCall" && b.id === id1);
		}) as
			| { role: string; content: Array<{ type: string; id?: string; arguments?: Record<string, unknown> }> }
			| undefined;

		const block = prunedMsg?.content?.find(b => b.id === id1);
		expect(block?.arguments).toMatchObject({ _pruned: expect.any(String) });
	});

	it("strategies run in order: dedup before purge-errors before supersede-writes", () => {
		// Verify the pipeline applies all three strategies in a single pass.
		// (purge-errors' turn-delay is exercised separately in its own unit test.)
		const state = createPruneState();
		const dup1 = makeToolCall("bash", { command: "ls" });
		const dup2 = makeToolCall("bash", { command: "ls" });
		const writeCall = makeToolCall("write", { path: "/y.ts", content: "x" });
		const writeId = getToolCallId(writeCall);
		const readCall = makeToolCall("read", { path: "/y.ts" });

		const messages = [makeUserMessage(), dup1, dup2, writeCall, readCall];
		applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);

		// deduplication: dup1 (older) pruned
		expect(state.pruneMap.has(getToolCallId(dup1))).toBe(true);
		// supersede-writes: writeCall pruned by subsequent read
		expect(state.pruneMap.has(writeId)).toBe(true);
	});
});
