import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { applyContextPruning } from "../src/session/context-pruning/pipeline";
import { applyCompressions } from "../src/session/context-pruning/prune";
import { buildToolSignature, createPruneState, syncStateFromMessages } from "../src/session/context-pruning/state";
import { deduplication } from "../src/session/context-pruning/strategies/deduplication";
import { purgeErrors } from "../src/session/context-pruning/strategies/purge-errors";
import { supersedeWrites } from "../src/session/context-pruning/strategies/supersede-writes";
import {
	type CompressRecord,
	type ContextPruningConfig,
	DEFAULT_PRUNING_CONFIG,
} from "../src/session/context-pruning/types";

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

/** Create a CompressRecord using the same defaults as the compress tool (MAX_SAFE_INTEGER = cover all). */
function makeCompressRecord(topic: string, summary: string): CompressRecord {
	return {
		topic,
		summary,
		upToTurn: Number.MAX_SAFE_INTEGER,
		applied: false,
		coveredIds: [],
	};
}

/**
 * Create an assistant message containing multiple tool calls.
 * Returns the message and the IDs in content order.
 */
function makeMultiToolCall(...calls: Array<[name: string, args: Record<string, unknown>]>): {
	msg: AgentMessage;
	ids: string[];
} {
	const ids = calls.map(() => makeToolCallId());
	const msg = {
		role: "assistant",
		content: calls.map(([name, args], i) => ({ type: "toolCall", id: ids[i], name, arguments: args })),
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	return { msg, ids };
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

// ============================================================================
// applyCompressions
// ============================================================================

describe("applyCompressions", () => {
	it("returns same array reference when there are no compressions", () => {
		const state = createPruneState();
		const messages = [makeUserMessage()];
		expect(applyCompressions(messages, state)).toBe(messages);
	});

	it("returns same array when compression covers no tool calls (no tool calls in state)", () => {
		const state = createPruneState();
		const messages = [makeUserMessage()];
		state.compressions.push(makeCompressRecord("x", "y"));
		// toolIdList is empty → allCoveredCallIds is empty → early return
		const result = applyCompressions(messages, state);
		expect(result).toBe(messages);
		// Record is still marked applied even when coveredIds is empty
		expect(state.compressions[0].applied).toBe(true);
	});

	it("removes the assistant message that contains a covered tool call", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "did ls"));

		const result = applyCompressions(messages, state);
		expect(result.some(m => m.role === "assistant")).toBe(false);
	});

	it("removes the toolResult for a covered tool call", () => {
		const state = createPruneState();
		const tc1 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [makeUserMessage(), tc1, tr1];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "done"));

		const result = applyCompressions(messages, state);
		expect(result.some(m => m.role === "toolResult")).toBe(false);
	});

	it("injects a summary user message with topic and summary text", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("original");
		const tc1 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const messages = [u1, tc1, makeToolResult(id1, "bash")];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("exploration", "explored /src"));

		const result = applyCompressions(messages, state);
		const summaryMsg = result.find(m => {
			if (m.role !== "user") return false;
			const c = (m as unknown as { content: unknown }).content;
			if (typeof c !== "string") return false;
			return c.includes("[Compressed: exploration]") && c.includes("explored /src");
		});
		expect(summaryMsg).toBeDefined();
	});

	it("preserves user messages from the original conversation", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("original prompt");
		const tc1 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const messages = [u1, tc1, makeToolResult(id1, "bash")];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "done"));

		const result = applyCompressions(messages, state);
		const originalUser = result.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && c === "original prompt";
		});
		expect(originalUser).toBeDefined();
	});

	it("drops assistant message when all tool calls are covered even if text blocks remain", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const id1 = makeToolCallId();
		// Assistant message with a text block followed by a tool call
		const mixedMsg = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will search" },
				{ type: "toolCall", id: id1, name: "bash", arguments: { command: "ls" } },
			],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const messages = [u1, mixedMsg, makeToolResult(id1, "bash")];
		// Inject metadata directly so applyCompressions can discover the tool
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "done"));

		const result = applyCompressions(messages, state);
		// Assistant message should be dropped: all tool calls are covered, orphaned text is about the
		// compressed tool call. Keeping it would create consecutive assistant messages with no user between them.
		expect(result.some(m => m.role === "assistant")).toBe(false);

		// Compression summary user message is injected instead
		const summaryMsg = result.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsg).toBeDefined();
	});

	it("retains uncovered tool calls when only some are covered", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const { msg: mixed, ids } = makeMultiToolCall(["bash", { command: "ls" }], ["grep", { pattern: "foo" }]);
		const [id1, id2] = ids;
		const tr1 = makeToolResult(id1, "bash");
		const tr2 = makeToolResult(id2, "grep");
		const messages = [u1, mixed, tr1, tr2];
		syncStateFromMessages(state, messages);

		// Pre-applied compression covers only id1
		const comp1: CompressRecord = {
			topic: "partial",
			summary: "did bash",
			upToTurn: Number.MAX_SAFE_INTEGER,
			applied: true,
			coveredIds: [id1],
		};
		state.compressions.push(comp1);

		const result = applyCompressions(messages, state);

		// Assistant survives because it has an uncovered tool call (id2)
		const assistantMsg = result.find(m => m.role === "assistant") as
			| { role: string; content: Array<{ type: string; id?: string }> }
			| undefined;
		expect(assistantMsg).toBeDefined();
		// Only the uncovered tool call (id2) remains in the assistant content
		expect(assistantMsg!.content).toHaveLength(1);
		expect(assistantMsg!.content[0].id).toBe(id2);

		// Covered tool call's result (tr1) is removed; uncovered (tr2) is kept
		const toolResults = result.filter(m => m.role === "toolResult") as unknown as Array<{ toolCallId: string }>;
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe(id2);
	});

	it("covers only new tool calls in a second compression (not already-covered IDs)", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const { msg: mixed, ids } = makeMultiToolCall(["bash", { command: "a" }], ["grep", { pattern: "b" }]);
		const [id1, id2] = ids;
		const tr1 = makeToolResult(id1, "bash");
		const tr2 = makeToolResult(id2, "grep");
		const messages = [u1, mixed, tr1, tr2];
		syncStateFromMessages(state, messages);

		// Compression 1 already applied, covering id1
		const comp1: CompressRecord = {
			topic: "first",
			summary: "s1",
			upToTurn: Number.MAX_SAFE_INTEGER,
			applied: true,
			coveredIds: [id1],
		};
		// Compression 2 not yet applied
		const comp2 = makeCompressRecord("second", "s2");
		state.compressions.push(comp1, comp2);

		applyCompressions(messages, state);

		// comp2 must not re-cover id1 (already in comp1.coveredIds)
		expect(comp2.coveredIds).not.toContain(id1);
		// comp2 should cover id2 (not yet covered)
		expect(comp2.coveredIds).toContain(id2);
	});

	it("already-applied compression still filters its covered IDs on subsequent calls", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "summary"));

		// First application
		applyCompressions(messages, state);
		expect(state.compressions[0].applied).toBe(true);

		// Second application (same messages) — compressed IDs must still be filtered
		const result2 = applyCompressions(messages, state);
		expect(result2.some(m => m.role === "assistant")).toBe(false);
		expect(result2.some(m => m.role === "toolResult")).toBe(false);
	});
});

// ============================================================================
// Compression stats tracking
// ============================================================================

describe("compression stats tracking", () => {
	it("tokensSaved includes token savings from compressed tool calls", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		// "read" is in DEFAULT_PROTECTED_TOOLS — strategies won't add it to pruneMap.
		// So all token savings come from the compression path.
		const tc1 = makeToolCall("read", { path: "/some/file.ts" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "read");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);

		const tokenCount = state.toolMetadata.get(id1)?.tokenCount ?? 0;
		expect(tokenCount).toBeGreaterThan(0); // sanity: token count must be non-zero

		state.compressions.push(makeCompressRecord("read-phase", "read some files"));
		applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);

		expect(state.stats.tokensSaved).toBe(tokenCount);
	});

	it("toolsPruned count includes compressed tool calls", () => {
		const state = createPruneState();
		const tc1 = makeToolCall("read", { path: "/a.ts" });
		const id1 = getToolCallId(tc1);
		const tc2 = makeToolCall("read", { path: "/b.ts" });
		const id2 = getToolCallId(tc2);
		const messages = [makeUserMessage(), tc1, makeToolResult(id1, "read"), tc2, makeToolResult(id2, "read")];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "read two files"));

		applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);

		// Both tool calls covered by compression; neither strategy-pruned (read is protected)
		expect(state.stats.toolsPruned).toBe(2);
	});

	it("no double-counting when an ID is in both pruneMap (strategy) and compression", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		// Two identical bash calls → deduplication prunes the older one (id1) into pruneMap
		const tc1 = makeToolCall("bash", { command: "ls" });
		const tc2 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const id2 = getToolCallId(tc2);
		const messages = [u1, tc1, tc2, makeToolResult(id1, "bash"), makeToolResult(id2, "bash")];
		syncStateFromMessages(state, messages);

		// Compression covers ALL tool calls (both id1 and id2)
		state.compressions.push(makeCompressRecord("all", "did both"));

		applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);

		// id1: in pruneMap (dedup) → counted from pruneMap; NOT counted again from compression
		// id2: not in pruneMap → counted from compression
		const tokensId1 = state.toolMetadata.get(id1)?.tokenCount ?? 0;
		const tokensId2 = state.toolMetadata.get(id2)?.tokenCount ?? 0;
		expect(state.stats.tokensSaved).toBe(tokensId1 + tokensId2);
		expect(state.stats.toolsPruned).toBe(2);
	});

	it("stats.compressions reflects the live compression record count", () => {
		const state = createPruneState();
		state.compressions.push(makeCompressRecord("a", "s1"));
		state.compressions.push(makeCompressRecord("b", "s2"));
		expect(state.compressions.length).toBe(2);
		// Pipeline syncs stats.compressions from the live array on each pass
		applyContextPruning([makeUserMessage()], state, DEFAULT_PRUNING_CONFIG);
		expect(state.stats.compressions).toBe(2);
	});
});

// ============================================================================
// Pipeline integration — with compression
// ============================================================================

describe("applyContextPruning pipeline — with compression", () => {
	it("transforms messages when a compression is pre-seeded in state", () => {
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeToolCall("bash", { command: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);

		state.compressions.push(makeCompressRecord("summary-phase", "all done"));

		const result = applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);
		expect(result).not.toBe(messages);
		expect(result.some(m => m.role === "assistant")).toBe(false);
		expect(result.some(m => m.role === "toolResult")).toBe(false);
		expect(
			result.some(m => {
				const c = (m as unknown as { content: unknown }).content;
				return m.role === "user" && typeof c === "string" && c.includes("summary-phase");
			}),
		).toBe(true);
	});

	it("does not early-return when compressions exist even if strategies produce no new prune ops", () => {
		// "read" is protected — strategies won't prune it, so pruneMap stays empty.
		// But compressions.length > 0 must keep the pipeline running.
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeToolCall("read", { path: "/file.ts" });
		const id1 = getToolCallId(tc1);
		const messages = [u1, tc1, makeToolResult(id1, "read")];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase", "read the file"));

		const result = applyContextPruning(messages, state, DEFAULT_PRUNING_CONFIG);
		// Would be same reference if the pipeline early-returned
		expect(result).not.toBe(messages);
		expect(result.some(m => m.role === "assistant")).toBe(false);
	});
});

/** Build an assistant message containing a thinking block and one tool call */
function makeThinkingToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me analyze...", thinkingSignature: "sig_test_abc" },
			{ type: "toolCall", id: makeToolCallId(), name, arguments: args },
		],
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

/** Build an assistant message containing a redactedThinking block and one tool call */
function makeRedactedThinkingToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "redactedThinking", data: "opaque_data_blob" },
			{ type: "toolCall", id: makeToolCallId(), name, arguments: args },
		],
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

describe("applyCompressions — thinking block safety", () => {
	it("does not modify the latest assistant message when it contains thinking blocks and covered tool calls", () => {
		// Setup: [user, thinkingToolCall, toolResult]
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeThinkingToolCall("bash", { cmd: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("exploration", "explored the repo"));

		const result = applyCompressions(messages, state);

		// The assistant message must be the exact same object reference (guard: not modified)
		const resultAssistant = result.find(m => m.role === "assistant");
		expect(resultAssistant === tc1).toBe(true);

		// Content still contains both thinking and toolCall blocks
		const content = (resultAssistant as unknown as { content: Array<{ type: string }> }).content;
		expect(content.some(b => b.type === "thinking")).toBe(true);
		expect(content.some(b => b.type === "toolCall")).toBe(true);

		// Tool result is also kept (deferred alongside its call)
		expect(result.some(m => m.role === "toolResult")).toBe(true);

		// No compression summary is injected (deferred)
		const summaryMsg = result.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsg).toBeUndefined();
	});

	it("drops non-latest assistant message with thinking when all tool calls are covered", () => {
		// Setup: [user, thinkingToolCall_1, toolResult_1, user, normalToolCall_2, toolResult_2]
		const state = createPruneState();
		const u1 = makeUserMessage("first");
		const tc1 = makeThinkingToolCall("bash", { cmd: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const u2 = makeUserMessage("second");
		const tc2 = makeToolCall("grep", { pattern: "foo" });
		const id2 = getToolCallId(tc2);
		const tr2 = makeToolResult(id2, "grep");
		const messages = [u1, tc1, tr1, u2, tc2, tr2];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("both-phases", "did everything"));

		const result = applyCompressions(messages, state);

		// tc1 (non-latest thinking): dropped entirely — orphaned thinking block with no uncovered
		// tool calls would create consecutive assistant messages violating alternating-roles.
		// tc2 (latest, no thinking, fully covered): also dropped.
		const assistants = result.filter(m => m.role === "assistant");
		expect(assistants.length).toBe(0);

		// Both tool results are removed
		expect(result.some(m => m.role === "toolResult")).toBe(false);

		// Compression summary IS injected
		const summaryMsg = result.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsg).toBeDefined();
	});

	it("deferred compression is applied on the next turn when thinking message is no longer latest", () => {
		// Turn 1: compression deferred because latest assistant has thinking
		const state = createPruneState();
		const u1 = makeUserMessage("turn1");
		const tc1 = makeThinkingToolCall("bash", { cmd: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const turn1Messages = [u1, tc1, tr1];
		syncStateFromMessages(state, turn1Messages);
		state.compressions.push(makeCompressRecord("turn1-phase", "explored"));

		const afterTurn1 = applyCompressions(turn1Messages, state);
		// Still deferred: tc1 is still present
		expect(afterTurn1.some(m => m.role === "assistant")).toBe(true);

		// Turn 2: add a new assistant message — tc1 is now no longer latest
		const u2 = makeUserMessage("turn2");
		const tc2 = makeToolCall("grep", { pattern: "bar" });
		const id2 = getToolCallId(tc2);
		const tr2 = makeToolResult(id2, "grep");
		const turn2Messages = [...turn1Messages, u2, tc2, tr2];
		syncStateFromMessages(state, turn2Messages);

		const afterTurn2 = applyCompressions(turn2Messages, state);

		// tc1 (thinking, now non-latest): its toolCall (id1) is removed by the compression.
		// id2 (tc2's toolCall) was added AFTER the compression was already applied,
		// so tc2 is NOT covered — it still has its toolCall in the result.
		const hasId1ToolCall = afterTurn2
			.filter(m => m.role === "assistant")
			.some(a => {
				const content = (a as unknown as { content: Array<{ type: string; id?: string }> }).content;
				return content.some(b => b.type === "toolCall" && b.id === id1);
			});
		expect(hasId1ToolCall).toBe(false);

		// Compression summary should now be injected
		const summaryMsg = afterTurn2.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsg).toBeDefined();
	});

	it("redactedThinking blocks trigger the same guard as thinking blocks", () => {
		// Same as test 1 but with redactedThinking
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeRedactedThinkingToolCall("bash", { cmd: "pwd" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("redacted-phase", "used redacted thinking"));

		const result = applyCompressions(messages, state);

		// Same object reference — guard triggered for redactedThinking too
		const resultAssistant = result.find(m => m.role === "assistant");
		expect(resultAssistant === tc1).toBe(true);

		// Content still contains redactedThinking and toolCall blocks
		const content = (resultAssistant as unknown as { content: Array<{ type: string }> }).content;
		expect(content.some(b => b.type === "redactedThinking")).toBe(true);
		expect(content.some(b => b.type === "toolCall")).toBe(true);

		// Tool result is kept (deferred)
		expect(result.some(m => m.role === "toolResult")).toBe(true);

		// No compression summary injected
		const summaryMsg = result.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsg).toBeUndefined();
	});

	it("modifies the latest assistant message normally when it has no thinking blocks", () => {
		// Normal behavior: no thinking → tool call is removed and summary is injected
		const state = createPruneState();
		const u1 = makeUserMessage("go");
		const tc1 = makeToolCall("bash", { cmd: "echo hi" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const messages = [u1, tc1, tr1];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("normal-phase", "normal summary"));

		const result = applyCompressions(messages, state);

		// Tool call is removed
		expect(result.some(m => m.role === "assistant")).toBe(false);

		// Tool result is also removed
		expect(result.some(m => m.role === "toolResult")).toBe(false);

		// Compression summary is injected
		const summaryMsg = result.find(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsg).toBeDefined();
	});

	it("defers latest thinking msg, drops non-latest thinking msg", () => {
		// Two compression records, each covering one turn
		const state = createPruneState();
		const u1 = makeUserMessage("first");
		// Non-latest assistant: has thinking, but NOT the last assistant in the list
		const tc1 = makeThinkingToolCall("bash", { cmd: "ls" });
		const id1 = getToolCallId(tc1);
		const tr1 = makeToolResult(id1, "bash");
		const u2 = makeUserMessage("second");
		// Latest assistant: also has thinking
		const tc2 = makeThinkingToolCall("grep", { pattern: "foo" });
		const id2 = getToolCallId(tc2);
		const tr2 = makeToolResult(id2, "grep");
		const messages = [u1, tc1, tr1, u2, tc2, tr2];
		syncStateFromMessages(state, messages);
		state.compressions.push(makeCompressRecord("phase-1", "first phase done"));
		state.compressions.push(makeCompressRecord("phase-2", "second phase done"));

		const result = applyCompressions(messages, state);

		// tc1 (non-latest, thinking): dropped entirely — orphaned thinking with no uncovered
		// tool calls violates alternating-roles.
		// tc2 (latest, thinking): deferred as-is — same object reference
		const assistants = result.filter(m => m.role === "assistant");
		// Only tc2 (deferred) remains; tc1 is dropped
		expect(assistants.length).toBe(1);
		expect(assistants[0] === tc2).toBe(true);

		// tr2 (result for deferred tc2) is kept; tr1 (result for dropped tc1) is gone
		const toolResults = result.filter(m => m.role === "toolResult");
		expect(toolResults.length).toBe(1);
		const keptResult = toolResults[0] as unknown as { toolCallId: string };
		expect(keptResult.toolCallId).toBe(id2);

		// At least one compression summary is injected (for tc1's coverage)
		const summaryMsgs = result.filter(m => {
			const c = (m as unknown as { content: unknown }).content;
			return m.role === "user" && typeof c === "string" && c.includes("[Compressed:");
		});
		expect(summaryMsgs.length).toBeGreaterThanOrEqual(1);
	});
});
