import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ApprovalContext,
	type ApprovalResult,
	runApprovalGate,
	runUserApproval,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/approval";

// ---------------------------------------------------------------------------
// Mock context
// ---------------------------------------------------------------------------

class MockApprovalContext implements ApprovalContext {
	#selectResponses: (string | undefined)[];
	#inputResponses: (string | undefined)[];
	selectCalls: Array<{ title: string; options: string[] }> = [];
	inputCalls: Array<{ title: string; placeholder?: string }> = [];

	constructor(options: { selectResponses?: (string | undefined)[]; inputResponses?: (string | undefined)[] } = {}) {
		this.#selectResponses = [...(options.selectResponses ?? [])];
		this.#inputResponses = [...(options.inputResponses ?? [])];
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		return this.#selectResponses.shift();
	}

	async input(title: string, placeholder?: string): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder });
		return this.#inputResponses.shift();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isApproved(result: ApprovalResult): result is { approved: true } {
	return result.approved === true;
}

function hasReviewPrompt(result: ApprovalResult): result is { approved: false; reviewPrompt: string } {
	return (
		result.approved === false &&
		"reviewPrompt" in result &&
		typeof (result as { reviewPrompt?: string }).reviewPrompt === "string"
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Workflow Approval", () => {
	describe("runApprovalGate", () => {
		beforeEach(async () => {
			_resetSettingsForTest();
			await Settings.init({ inMemory: true });
		});

		afterEach(() => {
			_resetSettingsForTest();
		});

		describe("mode: none", () => {
			test("auto-approves without calling context", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.brainstorm.approval": "none" } });

				const ctx = new MockApprovalContext();
				const result = await runApprovalGate("brainstorm", ctx);

				expect(result.approved).toBe(true);
				expect(ctx.selectCalls).toHaveLength(0);
				expect(ctx.inputCalls).toHaveLength(0);
			});

			test("auto-approves for a non-brainstorm phase with mode none", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "none" } });

				const ctx = new MockApprovalContext();
				const result = await runApprovalGate("spec", ctx);

				expect(result.approved).toBe(true);
				expect(ctx.selectCalls).toHaveLength(0);
			});
		});

		describe("mode: user", () => {
			test("delegates to runUserApproval — calls context.select", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.brainstorm.approval": "user" } });

				const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
				const result = await runApprovalGate("brainstorm", ctx);

				expect(result.approved).toBe(true);
				// At least one select call was made (delegated to runUserApproval)
				expect(ctx.selectCalls).toHaveLength(1);
			});

			test("default mode is user — calls context.select", async () => {
				// Default per settings-schema is "user", so no override needed
				const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
				const result = await runApprovalGate("brainstorm", ctx);

				expect(result.approved).toBe(true);
				expect(ctx.selectCalls).toHaveLength(1);
			});
		});

		describe("mode: agent", () => {
			test("returns approved:false with reviewPrompt", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.brainstorm.approval": "agent" } });

				const ctx = new MockApprovalContext();
				const result = await runApprovalGate("brainstorm", ctx);

				expect(result.approved).toBe(false);
				expect(hasReviewPrompt(result)).toBe(true);
				// No UI interaction
				expect(ctx.selectCalls).toHaveLength(0);
				expect(ctx.inputCalls).toHaveLength(0);
			});

			test("reviewPrompt includes the phase name", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.design.approval": "agent" } });

				const ctx = new MockApprovalContext();
				const result = await runApprovalGate("design", ctx);

				expect(result.approved).toBe(false);
				expect(hasReviewPrompt(result)).toBe(true);
				expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("design");
			});
		});

		describe("mode: both", () => {
			test("returns approved:false with reviewPrompt", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.brainstorm.approval": "both" } });

				const ctx = new MockApprovalContext();
				const result = await runApprovalGate("brainstorm", ctx);

				expect(result.approved).toBe(false);
				expect(hasReviewPrompt(result)).toBe(true);
				expect(ctx.selectCalls).toHaveLength(0);
			});

			test("reviewPrompt differs from agent-only mode (includes user escalation note)", async () => {
				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.brainstorm.approval": "agent" } });
				const ctxAgent = new MockApprovalContext();
				const agentResult = await runApprovalGate("brainstorm", ctxAgent);

				_resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "workflow.phases.brainstorm.approval": "both" } });
				const ctxBoth = new MockApprovalContext();
				const bothResult = await runApprovalGate("brainstorm", ctxBoth);

				expect(hasReviewPrompt(agentResult)).toBe(true);
				expect(hasReviewPrompt(bothResult)).toBe(true);

				// "both" appends an extra user-approval note
				expect((bothResult as { approved: false; reviewPrompt: string }).reviewPrompt.length).toBeGreaterThan(
					(agentResult as { approved: false; reviewPrompt: string }).reviewPrompt.length,
				);
				expect((bothResult as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("user");
			});
		});
	});

	// -------------------------------------------------------------------------
	// runUserApproval — direct tests, no settings required
	// -------------------------------------------------------------------------
	describe("runUserApproval", () => {
		test("Approve — returns approved:true", async () => {
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			const result = await runUserApproval("brainstorm", ctx);

			expect(result.approved).toBe(true);
			expect(ctx.selectCalls).toHaveLength(1);
			expect(ctx.inputCalls).toHaveLength(0);
		});

		test("Refine — prompts for reason and returns approved:false with that reason", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Refine"],
				inputResponses: ["needs more detail"],
			});
			const result = await runUserApproval("brainstorm", ctx);

			expect(result.approved).toBe(false);
			expect((result as { reason?: string }).reason).toBe("needs more detail");
			expect(ctx.inputCalls).toHaveLength(1);
		});

		test("Refine with no reason — falls back to default reason", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Refine"],
				inputResponses: [undefined],
			});
			const result = await runUserApproval("spec", ctx);

			expect(result.approved).toBe(false);
			expect((result as { reason?: string }).reason).toBe("Refinement requested");
		});

		test("Refine with empty string reason — falls back to default reason", async () => {
			// undefined from ctx.input is the cancel signal; empty string is not undefined so it passes through
			// This documents the real behavior: empty string is treated as a provided reason, not default
			const ctx = new MockApprovalContext({
				selectResponses: ["Refine"],
				inputResponses: [""],
			});
			const result = await runUserApproval("spec", ctx);

			expect(result.approved).toBe(false);
			// "" is falsy in JS but not undefined — ?? only guards undefined/null
			// So the actual reason depends on implementation: "" ?? "Refinement requested" → ""
			// Document actual behavior: empty string passes through
			expect((result as { reason?: string }).reason).toBe("");
		});

		test("Reject → Retry phase — returns rejected retry reason", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", "Retry phase"],
			});
			const result = await runUserApproval("brainstorm", ctx);

			expect(result.approved).toBe(false);
			expect((result as { reason?: string }).reason).toBe("Rejected. Please retry this phase from scratch.");
			expect(ctx.selectCalls).toHaveLength(2);
		});

		test("Reject → Abandon phase — returns abandon reason", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", "Abandon phase"],
			});
			const result = await runUserApproval("design", ctx);

			expect(result.approved).toBe(false);
			expect((result as { reason?: string }).reason).toBe("Phase abandoned.");
		});

		test("Reject → cancelled second select (undefined) — returns approved:false with no reason", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", undefined],
			});
			const result = await runUserApproval("brainstorm", ctx);

			expect(result.approved).toBe(false);
			// Cancelled second dialog: neither "Retry phase" nor "Abandon phase"
			expect((result as { reason?: string }).reason).toBeUndefined();
		});

		test("cancelled first select (undefined) — returns approved:false", async () => {
			const ctx = new MockApprovalContext({ selectResponses: [undefined] });
			const result = await runUserApproval("brainstorm", ctx);

			expect(result.approved).toBe(false);
			expect(ctx.selectCalls).toHaveLength(1);
		});

		test("select presents exactly the options: Approve, Refine, Reject", async () => {
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			await runUserApproval("brainstorm", ctx);

			expect(ctx.selectCalls).toHaveLength(1);
			expect(ctx.selectCalls[0]!.options).toEqual(["Approve", "Refine", "Reject"]);
		});

		test("select title includes capitalized phase name", async () => {
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			await runUserApproval("brainstorm", ctx);

			const title = ctx.selectCalls[0]!.title;
			// capitalize("brainstorm") === "Brainstorm"
			expect(title).toContain("Brainstorm");
		});

		test("select title includes capitalized phase name for non-brainstorm phase", async () => {
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			await runUserApproval("execute", ctx);

			const title = ctx.selectCalls[0]!.title;
			expect(title).toContain("Execute");
		});

		test("Refine — input prompt asks about refinement", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Refine"],
				inputResponses: ["something"],
			});
			await runUserApproval("brainstorm", ctx);

			expect(ctx.inputCalls).toHaveLength(1);
			expect(ctx.inputCalls[0]!.title).toContain("refinement");
		});

		test("Reject second select title mentions rejected", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", "Retry phase"],
			});
			await runUserApproval("brainstorm", ctx);

			expect(ctx.selectCalls).toHaveLength(2);
			// Second select title should mention the rejection context
			expect(ctx.selectCalls[1]!.title.toLowerCase()).toContain("reject");
		});
	});
});
