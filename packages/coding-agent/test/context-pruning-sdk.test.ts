/**
 * SDK-level integration tests for context pruning / compression wiring.
 *
 * Two test groups:
 *
 * 1. "createAgentSession compression wiring" — verifies addCompressionRecord
 *    and getPruningStats are wired correctly without any LLM calls.
 *
 * 2. "compression pipeline E2E (mocked LLM)" — exercises the full compression
 *    pipeline via a scripted streamFn.  Confirms that compressed tool calls are
 *    removed from the LLM context and that stats reflect the savings.
 *
 * Wiring note for group 2:
 *   AgentSession.#transformContext (which wraps applyContextPruning) is NOT
 *   automatically called in the agent loop — the Agent uses its own
 *   config.transformContext.  The tests bridge this by passing a lazy closure
 *   as the Agent's convertToLlm that routes through
 *   session.convertMessagesToLlm(), which internally calls
 *   AgentSession.#transformContext (including applyContextPruning) and then
 *   the base convertToLlm.  Once sessionRef is resolved after construction,
 *   every LLM call in the agent loop goes through the pruning pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, getBundledModel, type ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompressRecord } from "@oh-my-pi/pi-coding-agent/session/context-pruning/types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Shared helpers
// ============================================================================

class MockAssistantStream extends AssistantMessageEventStream {}

/** Monotonically increasing counter for unique tool call IDs within a test run. */
let _toolCallSeq = 0;

function makeAssistantTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeAssistantToolCallMessage(toolName: string, args: Record<string, unknown> = {}): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: `call_${toolName}_${++_toolCallSeq}`,
		name: toolName,
		arguments: args,
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function makeAssistantThinkingToolCallMessage(toolName: string, args: Record<string, unknown> = {}): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: `call_${toolName}_${++_toolCallSeq}`,
		name: toolName,
		arguments: args,
	};
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me think about this...", thinkingSignature: "sig_mock_test" },
			toolCall,
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function mockStream(response: AssistantMessage): MockAssistantStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: response });
		const reason =
			response.stopReason === "toolUse" || response.stopReason === "length" ? response.stopReason : "stop";
		stream.push({ type: "done", reason, message: response });
	});
	return stream;
}

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
 * Return true if any message in `msgs` is an assistant message whose content
 * contains at least one toolCall block — i.e. the LLM can still see a tool call.
 */
function hasToolCallBlock(msgs: any[]): boolean {
	return msgs.some(m => {
		if (m.role !== "assistant") return false;
		const content = m.content;
		if (!Array.isArray(content)) return false;
		return content.some((b: { type?: string }) => b.type === "toolCall");
	});
}

/**
 * Find the compression summary string injected into `msgs` by applyCompressions.
 * The summary is a user message with string content starting with "[Compressed:".
 * Returns the string or undefined when not present.
 */
function findCompressionSummary(msgs: any[]): string | undefined {
	for (const m of msgs) {
		if (m.role !== "user") continue;
		const c = m.content;
		if (typeof c === "string" && c.includes("[Compressed:")) return c;
		if (Array.isArray(c)) {
			for (const b of c as Array<{ type?: string; text?: string }>) {
				if (b.type === "text" && b.text?.includes("[Compressed:")) return b.text;
			}
		}
	}
	return undefined;
}

// ============================================================================
// Existing wiring tests (no LLM calls)
// ============================================================================

interface MinimalSession {
	session: AgentSession;
	dispose: () => Promise<void>;
}

async function createMinimalSession(): Promise<MinimalSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-compress-sdk-${Snowflake.next()}-`));
	const cwd = path.join(tempDir, "project");
	const agentDir = path.join(tempDir, "agent");
	fs.mkdirSync(cwd, { recursive: true });

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	});

	return {
		session,
		dispose: async () => {
			await session.dispose();
			fs.rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("createAgentSession compression wiring", () => {
	let ctx: MinimalSession | undefined;

	afterEach(async () => {
		await ctx?.dispose();
		ctx = undefined;
	});

	it("initial getPruningStats returns all-zero values", async () => {
		ctx = await createMinimalSession();
		const stats = ctx.session.getPruningStats();
		expect(stats.tokensSaved).toBe(0);
		expect(stats.toolsPruned).toBe(0);
		expect(stats.currentTurn).toBe(0);
		expect(stats.compressions).toBe(0);
	});

	it("addCompressionRecord increments compressions in getPruningStats", async () => {
		ctx = await createMinimalSession();
		ctx.session.addCompressionRecord(makeCompressRecord("file exploration", "explored /src"));
		expect(ctx.session.getPruningStats().compressions).toBe(1);
	});

	it("addCompressionRecord is additive across multiple calls", async () => {
		ctx = await createMinimalSession();
		ctx.session.addCompressionRecord(makeCompressRecord("phase 1", "s1"));
		ctx.session.addCompressionRecord(makeCompressRecord("phase 2", "s2"));
		expect(ctx.session.getPruningStats().compressions).toBe(2);
	});

	it("getPruningStats reflects exact record count, not a snapshot", async () => {
		ctx = await createMinimalSession();
		// Add one, check, add another, check — live read, no staleness
		ctx.session.addCompressionRecord(makeCompressRecord("a", "first"));
		expect(ctx.session.getPruningStats().compressions).toBe(1);
		ctx.session.addCompressionRecord(makeCompressRecord("b", "second"));
		expect(ctx.session.getPruningStats().compressions).toBe(2);
	});

	it("sweepContextPruning returns a well-formed PruningStats object", async () => {
		ctx = await createMinimalSession();
		const stats = ctx.session.sweepContextPruning();
		// Shape contract: all four fields present and correctly typed
		expect(typeof stats.tokensSaved).toBe("number");
		expect(typeof stats.toolsPruned).toBe("number");
		expect(typeof stats.currentTurn).toBe("number");
		expect(typeof stats.compressions).toBe("number");
	});

	it("sweepContextPruning includes compression count even with no agent messages", async () => {
		ctx = await createMinimalSession();
		ctx.session.addCompressionRecord(makeCompressRecord("phase", "done"));
		const stats = ctx.session.sweepContextPruning();
		// compressions comes directly from the live array, not from the stats struct
		expect(stats.compressions).toBe(1);
		// No messages in the agent — nothing was compressed, no token savings
		expect(stats.tokensSaved).toBe(0);
		expect(stats.toolsPruned).toBe(0);
	});

	it("sweepContextPruning is idempotent when called multiple times with no new messages", async () => {
		ctx = await createMinimalSession();
		ctx.session.addCompressionRecord(makeCompressRecord("phase", "done"));
		const first = ctx.session.sweepContextPruning();
		const second = ctx.session.sweepContextPruning();
		expect(second.compressions).toBe(first.compressions);
		expect(second.tokensSaved).toBe(first.tokensSaved);
		expect(second.toolsPruned).toBe(first.toolsPruned);
	});

	it("getPruningStats and sweepContextPruning agree on compression count", async () => {
		ctx = await createMinimalSession();
		ctx.session.addCompressionRecord(makeCompressRecord("x", "y"));
		const fromStats = ctx.session.getPruningStats();
		const fromSweep = ctx.session.sweepContextPruning();
		expect(fromSweep.compressions).toBe(fromStats.compressions);
	});
});

// ============================================================================
// E2E tests with mocked LLM — full pipeline including applyContextPruning
// ============================================================================

describe("compression pipeline E2E (mocked LLM)", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;
	let scriptedResponses: AssistantMessage[];

	// Snapshots of context.messages (LLM-format) captured on each streamFn call.
	// Snapshots of context.messages (LLM-format) captured on each streamFn call.
	let capturedContexts: any[][];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-compression-e2e-");
		scriptedResponses = [];
		capturedContexts = [];
		_toolCallSeq = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to be bundled");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(tempDir.path());

		// A simple mock tool — name "bash", always returns a fixed result.
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: Type.Object({ command: Type.Optional(Type.String()) }),
			execute: async () => ({ content: [{ type: "text" as const, text: "file1.ts\nfile2.ts" }] }),
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [mockBashTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (_model, context, _options) => {
				// Capture a shallow copy so post-turn mutations don't affect inspection.
				capturedContexts.push([...context.messages]);
				const response = scriptedResponses.shift() ?? makeAssistantTextMessage("done");
				return mockStream(response);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// Mirror the SDK pattern: wire the session's full transform pipeline
		// (extension context + applyContextPruning) into the agent loop.
		agent.transformContext = session.getContextTransform();
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	/**
	 * Core E2E test: after a tool call turn followed by addCompressionRecord,
	 * the compressed tool call must NOT appear in the next LLM context.
	 * The compression summary MUST appear as a user message instead.
	 */
	it("compressed tool calls are removed from LLM context on next turn", async () => {
		// Turn 1: tool call → executes → text response (2 streamFn calls)
		scriptedResponses = [makeAssistantToolCallMessage("bash", { command: "ls" }), makeAssistantTextMessage("done")];
		await session.prompt("run ls");

		expect(capturedContexts).toHaveLength(2); // sanity check

		// Inject compression record AFTER turn 1 completes
		session.addCompressionRecord(makeCompressRecord("file listing", "ran ls, found file1.ts and file2.ts"));

		// Turn 2: plain text response (1 streamFn call)
		scriptedResponses = [makeAssistantTextMessage("continuing")];
		await session.prompt("continue");

		// capturedContexts[2] is the context presented to the LLM for turn 2
		const turn2Context = capturedContexts[2];
		expect(turn2Context).toBeDefined();

		// The bash tool call from turn 1 must not be visible
		expect(hasToolCallBlock(turn2Context)).toBe(false);

		// A compression summary must be present in its place
		const summary = findCompressionSummary(turn2Context);
		expect(summary).toBeTruthy();
		expect(summary).toContain("[Compressed:");
		expect(summary).toContain("file listing");
	});

	/**
	 * Stats verification: after the LLM sees the compressed context, the pruning
	 * stats must reflect nonzero token savings and a compression count of 1.
	 */
	it("getPruningStats reflects compression token savings after transformContext runs", async () => {
		// Turn 1: tool call
		scriptedResponses = [makeAssistantToolCallMessage("bash", { command: "ls" }), makeAssistantTextMessage("done")];
		await session.prompt("run ls");

		session.addCompressionRecord(makeCompressRecord("exploration", "explored the repo"));

		// Turn 2 triggers applyContextPruning which applies the compression
		scriptedResponses = [makeAssistantTextMessage("done")];
		await session.prompt("continue");

		const stats = session.getPruningStats();
		// At least one tool call was compressed → nonzero savings
		expect(stats.tokensSaved).toBeGreaterThan(0);
		// The bash tool call counts as pruned
		expect(stats.toolsPruned).toBeGreaterThanOrEqual(1);
		// Exactly one compression record was registered
		expect(stats.compressions).toBe(1);
	});

	/**
	 * The compression summary text injected into LLM context must match the
	 * exact format "[Compressed: <topic>]\n\n<summary>" produced by applyCompressions.
	 */
	it("compression summary text appears verbatim in LLM context", async () => {
		const topic = "initial-exploration";
		const summary = "Listed source files; found 12 modules.";

		scriptedResponses = [
			makeAssistantToolCallMessage("bash", { command: "ls -la" }),
			makeAssistantTextMessage("done"),
		];
		await session.prompt("explore the codebase");

		session.addCompressionRecord(makeCompressRecord(topic, summary));

		scriptedResponses = [makeAssistantTextMessage("done")];
		await session.prompt("continue");

		const turn2Context = capturedContexts[2];
		expect(turn2Context).toBeDefined();

		const found = findCompressionSummary(turn2Context);
		expect(found).toBe(`[Compressed: ${topic}]\n\n${summary}`);
	});

	/**
	 * When a turn produces multiple sequential tool calls, one compression record
	 * must hide ALL of them from the next LLM context and inject a single summary.
	 */
	it("multiple tool calls in one turn are all compressed", async () => {
		// Turn 1: two sequential tool calls, then text
		// streamFn call 1 → tool call 1 → executes
		// streamFn call 2 → tool call 2 → executes
		// streamFn call 3 → text "done"
		scriptedResponses = [
			makeAssistantToolCallMessage("bash", { command: "ls" }),
			makeAssistantToolCallMessage("bash", { command: "pwd" }),
			makeAssistantTextMessage("done"),
		];
		await session.prompt("explore");

		expect(capturedContexts).toHaveLength(3); // 3 LLM calls in turn 1

		// One compression record covers both tool calls (upToTurn = MAX_SAFE_INTEGER)
		session.addCompressionRecord(makeCompressRecord("exploration", "ran ls and pwd"));

		scriptedResponses = [makeAssistantTextMessage("done")];
		await session.prompt("continue");

		const turn2Context = capturedContexts[3];
		expect(turn2Context).toBeDefined();

		// Neither tool call should appear
		expect(hasToolCallBlock(turn2Context)).toBe(false);

		// Summary is injected exactly once (one record → one injection)
		const summaries = (turn2Context as Array<{ role: string; content: unknown }>).filter(
			m => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("[Compressed:"),
		);
		expect(summaries).toHaveLength(1);

		// Stats reflect both tool calls compressed
		const stats = session.getPruningStats();
		expect(stats.toolsPruned).toBeGreaterThanOrEqual(2);
		expect(stats.compressions).toBe(1);
	});

	/**
	 * When a second compression is added after a second turn, it must only cover
	 * tool calls from that second turn — not re-cover tool calls already owned
	 * by the first compression.
	 */
	it("second compression does not re-cover tool calls from first compression", async () => {
		// Turn 1: tool call A
		scriptedResponses = [makeAssistantToolCallMessage("bash", { command: "ls" }), makeAssistantTextMessage("done")];
		await session.prompt("turn 1");

		// Compress turn 1's tool call
		session.addCompressionRecord(makeCompressRecord("phase-1", "listed files"));

		// Turn 2: tool call B (different command so not deduplicated)
		scriptedResponses = [makeAssistantToolCallMessage("bash", { command: "pwd" }), makeAssistantTextMessage("done")];
		await session.prompt("turn 2");

		// Compress turn 2's tool call separately
		session.addCompressionRecord(makeCompressRecord("phase-2", "found working dir"));

		// Turn 3: no tool call — inspect what the LLM sees
		scriptedResponses = [makeAssistantTextMessage("done")];
		await session.prompt("turn 3");

		// The context for turn 3 should have:
		//   - summary for phase-1  (user msg)
		//   - summary for phase-2  (user msg)
		//   - NO tool call blocks from either turn
		const turn3Idx = capturedContexts.length - 1;
		const turn3Context = capturedContexts[turn3Idx];
		expect(turn3Context).toBeDefined();

		expect(hasToolCallBlock(turn3Context)).toBe(false);

		const phase1Found = (turn3Context as Array<{ role: string; content: unknown }>).some(
			m => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("phase-1"),
		);
		const phase2Found = (turn3Context as Array<{ role: string; content: unknown }>).some(
			m => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("phase-2"),
		);
		expect(phase1Found).toBe(true);
		expect(phase2Found).toBe(true);

		// Two distinct compression records
		expect(session.getPruningStats().compressions).toBe(2);
	});

	/**
	 * After compression the session must remain fully functional: subsequent prompts
	 * complete normally, the compressed context is stable, and stats are consistent.
	 */
	it("session continues functioning after compression", async () => {
		// Turn 1: tool call → text
		scriptedResponses = [
			makeAssistantToolCallMessage("bash", { command: "ls" }),
			makeAssistantTextMessage("turn1-done"),
		];
		await session.prompt("turn 1");

		session.addCompressionRecord(makeCompressRecord("work", "exploration complete"));

		// Turn 2: plain text prompt/response — no tool calls, exercises post-compression path
		scriptedResponses = [makeAssistantTextMessage("turn2-done")];
		await session.prompt("turn 2");

		// Turn 3: another plain prompt — the context should still be stable
		scriptedResponses = [makeAssistantTextMessage("turn3-done")];
		await session.prompt("turn 3");

		// Three prompts × expected streamFn call count: 2 (turn1) + 1 (turn2) + 1 (turn3) = 4
		expect(capturedContexts).toHaveLength(4);

		// Turns 2 and 3 see no tool calls
		expect(hasToolCallBlock(capturedContexts[2])).toBe(false);
		expect(hasToolCallBlock(capturedContexts[3])).toBe(false);

		// Compression summary is present in turn 2 and turn 3 contexts
		expect(findCompressionSummary(capturedContexts[2])).toBeTruthy();
		expect(findCompressionSummary(capturedContexts[3])).toBeTruthy();

		// Stats remain stable after multiple turns
		const stats = session.getPruningStats();
		expect(stats.compressions).toBe(1);
		expect(stats.tokensSaved).toBeGreaterThan(0);
	});

	/**
	 * Thinking block safety E2E: when the latest assistant message has thinking blocks,
	 * its tool calls are NOT removed by compression. On the NEXT turn (when a new
	 * assistant message becomes the latest), the deferred tool calls ARE removed and
	 * the compression summary is injected.
	 */
	it("compression defers removal of latest assistant message with thinking blocks", async () => {
		// Turn 1: thinking + tool call → executes → text response (2 streamFn calls)
		scriptedResponses = [
			makeAssistantThinkingToolCallMessage("bash", { command: "ls" }),
			makeAssistantTextMessage("done with turn 1"),
		];
		await session.prompt("turn 1");

		// Add compression covering turn 1
		session.addCompressionRecord(makeCompressRecord("phase-1", "explored files"));

		// Turn 2: plain text response.
		// The tool call assistant from turn 1 has thinking blocks, but the latest
		// assistant is now the text message. Compression should apply.
		scriptedResponses = [makeAssistantTextMessage("turn 2 done")];
		await session.prompt("turn 2");

		// The tool call from turn 1 should be removed (it's not the latest assistant)
		const turn2Context = capturedContexts[capturedContexts.length - 1];
		expect(turn2Context).toBeDefined();
		expect(hasToolCallBlock(turn2Context)).toBe(false);

		// Compression summary should be present
		const summary = findCompressionSummary(turn2Context);
		expect(summary).toBeTruthy();
		expect(summary).toContain("phase-1");

		// Stats reflect the compression
		const stats = session.getPruningStats();
		expect(stats.compressions).toBe(1);
		expect(stats.tokensSaved).toBeGreaterThan(0);
	});

	/**
	 * When the latest assistant message has both thinking blocks and covered tool calls,
	 * those tool calls must survive in the LLM context (not be stripped). The next turn
	 * must then remove them once a newer assistant message takes over as latest.
	 */
	it("thinking blocks in latest assistant preserve tool calls until next turn", async () => {
		// Turn 1: thinking + tool call → executes → text response
		scriptedResponses = [
			makeAssistantThinkingToolCallMessage("bash", { command: "ls" }),
			makeAssistantTextMessage("done"),
		];
		await session.prompt("turn 1");

		session.addCompressionRecord(makeCompressRecord("phase-1", "listed files"));

		// Turn 2: another tool call with thinking, then text
		scriptedResponses = [
			makeAssistantThinkingToolCallMessage("bash", { command: "pwd" }),
			makeAssistantTextMessage("done 2"),
		];
		await session.prompt("turn 2");

		session.addCompressionRecord(makeCompressRecord("phase-2", "found working dir"));

		// Turn 3: text only — both compressions should apply
		scriptedResponses = [makeAssistantTextMessage("turn 3 done")];
		await session.prompt("turn 3");

		const turn3Context = capturedContexts[capturedContexts.length - 1];
		expect(turn3Context).toBeDefined();

		// Both compressions should have removed their tool calls
		expect(hasToolCallBlock(turn3Context)).toBe(false);

		// Both summaries should be present
		const allSummaries = (turn3Context as Array<{ role: string; content: unknown }>).filter(
			m => m.role === "user" && typeof m.content === "string" && (m.content as string).includes("[Compressed:"),
		);
		expect(allSummaries.length).toBe(2);

		// The important assertion: no tool calls remain.
		expect(session.getPruningStats().compressions).toBe(2);
	});
});
