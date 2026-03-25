import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import { _resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ApprovalContext,
	type ApprovalResult,
	runApprovalGate,
	runUserApproval,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/approval";
import {
	PHASES,
	type WorkflowPhase,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";

// ---------------------------------------------------------------------------
// Mock context
// ---------------------------------------------------------------------------

class MockApprovalContext implements ApprovalContext {
	#selectResponses: (string | undefined)[];
	#inputResponses: (string | undefined)[];
	selectCalls: Array<{ title: string; options: string[] }> = [];
	inputCalls: Array<{ title: string; placeholder?: string }> = [];

	constructor(opts: { selectResponses?: (string | undefined)[]; inputResponses?: (string | undefined)[] } = {}) {
		this.#selectResponses = [...(opts.selectResponses ?? [])];
		this.#inputResponses = [...(opts.inputResponses ?? [])];
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
// Type narrowing helpers
// ---------------------------------------------------------------------------

function hasReviewPrompt(result: ApprovalResult): result is { approved: false; reviewPrompt: string } {
	return (
		result.approved === false &&
		"reviewPrompt" in result &&
		typeof (result as { reviewPrompt?: string }).reviewPrompt === "string"
	);
}

function reasonOf(result: ApprovalResult): string | undefined {
	if (result.approved) return undefined;
	return (result as { reason?: string }).reason;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Workflow Approval — edge cases", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	// -------------------------------------------------------------------------
	// runApprovalGate — settings isolation and fallback
	// -------------------------------------------------------------------------

	describe("runApprovalGate — per-phase settings isolation", () => {
		test("each phase reads its own approval setting independently", async () => {
			// Set four different modes on four phases, all in a single init.
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.brainstorm.approval": "none",
					"workflow.phases.spec.approval": "user",
					"workflow.phases.design.approval": "agent",
					"workflow.phases.plan.approval": "both",
				},
			});

			// brainstorm=none → auto-approve, no UI calls
			const brainstormCtx = new MockApprovalContext();
			const brainstormResult = await runApprovalGate("brainstorm", brainstormCtx);
			expect(brainstormResult.approved).toBe(true);
			expect(brainstormCtx.selectCalls).toHaveLength(0);

			// spec=user → calls UI select
			const specCtx = new MockApprovalContext({ selectResponses: ["Approve"] });
			const specResult = await runApprovalGate("spec", specCtx);
			expect(specResult.approved).toBe(true);
			expect(specCtx.selectCalls).toHaveLength(1);

			// design=agent → reviewPrompt, no UI calls
			const designCtx = new MockApprovalContext();
			const designResult = await runApprovalGate("design", designCtx);
			expect(designResult.approved).toBe(false);
			expect(hasReviewPrompt(designResult)).toBe(true);
			expect(designCtx.selectCalls).toHaveLength(0);

			// plan=both → reviewPrompt, no UI calls
			const planCtx = new MockApprovalContext();
			const planResult = await runApprovalGate("plan", planCtx);
			expect(planResult.approved).toBe(false);
			expect(hasReviewPrompt(planResult)).toBe(true);
			expect(planCtx.selectCalls).toHaveLength(0);
		});

		test("one phase having 'none' does not affect another phase's 'user' setting", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.brainstorm.approval": "none",
					"workflow.phases.verify.approval": "user",
				},
			});

			const verifyCtx = new MockApprovalContext({ selectResponses: ["Approve"] });
			const verifyResult = await runApprovalGate("verify", verifyCtx);
			expect(verifyResult.approved).toBe(true);
			expect(verifyCtx.selectCalls).toHaveLength(1);
		});
	});

	describe("runApprovalGate — unknown/undefined mode falls back to user", () => {
		test("unknown approval mode triggers user approval flow", async () => {
			// Force an invalid mode value through the settings override path.
			// The switch default branch logs a warning and delegates to runUserApproval.
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				// Cast to bypass TypeScript's enum guard — we want to exercise the default branch.
				overrides: { "workflow.phases.brainstorm.approval": "unknown-mode" as "user" },
			});

			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			const result = await runApprovalGate("brainstorm", ctx);

			// Falls through to runUserApproval — must have called select
			expect(result.approved).toBe(true);
			expect(ctx.selectCalls).toHaveLength(1);
		});
	});

	describe("runApprovalGate — reviewAgent appears in reviewPrompt", () => {
		test("reviewAgent=critic is mentioned in the agent-mode reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.brainstorm.approval": "agent",
					"workflow.phases.brainstorm.reviewAgent": "critic",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("brainstorm", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("critic");
		});

		test("reviewAgent=reviewer is mentioned in the agent-mode reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.spec.approval": "agent",
					"workflow.phases.spec.reviewAgent": "reviewer",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("spec", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("reviewer");
		});

		test("reviewAgent=critic is mentioned in the both-mode reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.design.approval": "both",
					"workflow.phases.design.reviewAgent": "critic",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("design", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("critic");
		});

		test("reviewAgent=reviewer is mentioned in the both-mode reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.plan.approval": "both",
					"workflow.phases.plan.reviewAgent": "reviewer",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("plan", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("reviewer");
		});
	});

	describe("runApprovalGate — maxReviewRounds in reviewPrompt", () => {
		test("maxReviewRounds=3 (default) produces plural 'iterations' in reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.brainstorm.approval": "agent",
					"workflow.phases.brainstorm.maxReviewRounds": "3",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("brainstorm", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("3");
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("iterations");
		});

		test("maxReviewRounds=1 produces singular 'iteration' in reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.spec.approval": "agent",
					"workflow.phases.spec.maxReviewRounds": "1",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("spec", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("1");
			// Singular: "iteration" not "iterations"
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toMatch(/\biteration\b/);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).not.toMatch(/\biterations\b/);
		});

		test("maxReviewRounds=5 produces '5' and plural 'iterations' in reviewPrompt", async () => {
			_resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"workflow.phases.design.approval": "agent",
					"workflow.phases.design.maxReviewRounds": "5",
				},
			});

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("design", ctx);

			expect(hasReviewPrompt(result)).toBe(true);
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("5");
			expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("iterations");
		});
	});

	describe("runApprovalGate — runtime settings override", () => {
		test("settings.override() after init changes approval behavior for that call", async () => {
			// Default is "user" — we override to "none" at runtime
			settings.override("workflow.phases.brainstorm.approval" as SettingPath, "none" as never);

			const ctx = new MockApprovalContext();
			const result = await runApprovalGate("brainstorm", ctx);

			expect(result.approved).toBe(true);
			expect(ctx.selectCalls).toHaveLength(0);
		});

		test("clearing override restores default 'user' behavior", async () => {
			settings.override("workflow.phases.brainstorm.approval" as SettingPath, "none" as never);
			settings.clearOverride("workflow.phases.brainstorm.approval" as SettingPath);

			// Default should be "user" again — requires a select call
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			const result = await runApprovalGate("brainstorm", ctx);

			expect(result.approved).toBe(true);
			expect(ctx.selectCalls).toHaveLength(1);
		});

		test("changing mode between two calls produces different behavior each time", async () => {
			// First call: agent mode → reviewPrompt
			settings.override("workflow.phases.brainstorm.approval" as SettingPath, "agent" as never);
			const ctxFirst = new MockApprovalContext();
			const firstResult = await runApprovalGate("brainstorm", ctxFirst);
			expect(firstResult.approved).toBe(false);
			expect(hasReviewPrompt(firstResult)).toBe(true);

			// Change to none → auto-approve
			settings.override("workflow.phases.brainstorm.approval" as SettingPath, "none" as never);
			const ctxSecond = new MockApprovalContext();
			const secondResult = await runApprovalGate("brainstorm", ctxSecond);
			expect(secondResult.approved).toBe(true);
			expect(ctxSecond.selectCalls).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// runUserApproval — exact option strings and second-select behavior
	// -------------------------------------------------------------------------

	describe("runUserApproval — exact option and title text", () => {
		test("first select options are exactly ['Approve', 'Refine', 'Reject']", async () => {
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			await runUserApproval("brainstorm", ctx);

			expect(ctx.selectCalls).toHaveLength(1);
			expect(ctx.selectCalls[0]!.options).toEqual(["Approve", "Refine", "Reject"]);
		});

		test("select title includes the capitalized phase name", async () => {
			const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
			await runUserApproval("execute", ctx);

			expect(ctx.selectCalls[0]!.title).toContain("Execute");
		});

		test("Reject — second select options include retry and abandon choices", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", "Retry phase"],
			});
			await runUserApproval("brainstorm", ctx);

			expect(ctx.selectCalls).toHaveLength(2);
			const secondOptions = ctx.selectCalls[1]!.options;
			// Document the actual option strings from the source
			expect(secondOptions).toContain("Retry phase");
			expect(secondOptions).toContain("Abandon phase");
		});

		test("Reject → Retry phase — reason is the retry message from source", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", "Retry phase"],
			});
			const result = await runUserApproval("plan", ctx);

			expect(result.approved).toBe(false);
			expect(reasonOf(result)).toBe("Rejected. Please retry this phase from scratch.");
		});

		test("Reject → Abandon phase — reason is the abandon message from source", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", "Abandon phase"],
			});
			const result = await runUserApproval("verify", ctx);

			expect(result.approved).toBe(false);
			expect(reasonOf(result)).toBe("Phase abandoned.");
		});

		test("Reject + cancel second selector (undefined) — approved:false with undefined reason", async () => {
			const ctx = new MockApprovalContext({
				selectResponses: ["Reject", undefined],
			});
			const result = await runUserApproval("design", ctx);

			expect(result.approved).toBe(false);
			expect(reasonOf(result)).toBeUndefined();
		});

		test("Refine — empty string input passes through as reason (not defaulted)", async () => {
			// "" is not undefined, so ?? fallback does not trigger; empty string is the reason
			const ctx = new MockApprovalContext({
				selectResponses: ["Refine"],
				inputResponses: [""],
			});
			const result = await runUserApproval("spec", ctx);

			expect(result.approved).toBe(false);
			expect(reasonOf(result)).toBe("");
		});

		test("Refine — undefined input falls back to default reason string", async () => {
			// undefined ?? "Refinement requested" → "Refinement requested"
			const ctx = new MockApprovalContext({
				selectResponses: ["Refine"],
				inputResponses: [undefined],
			});
			const result = await runUserApproval("brainstorm", ctx);

			expect(result.approved).toBe(false);
			expect(reasonOf(result)).toBe("Refinement requested");
		});
	});

	// -------------------------------------------------------------------------
	// All seven phases produce a valid result when approved
	// -------------------------------------------------------------------------

	describe("runUserApproval — all phases produce valid results on Approve", () => {
		test("every phase returns approved:true when user selects Approve", async () => {
			for (const phase of PHASES) {
				const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
				const result = await runUserApproval(phase as WorkflowPhase, ctx);

				expect(result.approved).toBe(true);
				expect(ctx.selectCalls).toHaveLength(1);
				expect(ctx.inputCalls).toHaveLength(0);
			}
		});

		test("every phase's select title contains that phase's capitalized name", async () => {
			for (const phase of PHASES) {
				const ctx = new MockApprovalContext({ selectResponses: ["Approve"] });
				await runUserApproval(phase as WorkflowPhase, ctx);

				const title = ctx.selectCalls[0]!.title;
				const capitalized = phase.charAt(0).toUpperCase() + phase.slice(1);
				expect(title).toContain(capitalized);
			}
		});
	});

	// -------------------------------------------------------------------------
	// runApprovalGate — phase name in reviewPrompt
	// -------------------------------------------------------------------------

	describe("runApprovalGate — phase name in reviewPrompt for all agent-mode phases", () => {
		const agentPhases: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan"];

		for (const phase of agentPhases) {
			test(`agent mode for '${phase}' includes phase name in reviewPrompt`, async () => {
				_resetSettingsForTest();
				await Settings.init({
					inMemory: true,
					overrides: {
						[`workflow.phases.${phase}.approval`]: "agent",
					} as Partial<Record<SettingPath, unknown>>,
				});

				const ctx = new MockApprovalContext();
				const result = await runApprovalGate(phase, ctx);

				expect(hasReviewPrompt(result)).toBe(true);
				expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain(phase);
			});
		}
	});
});
