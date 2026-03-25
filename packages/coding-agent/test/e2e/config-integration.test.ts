import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import { _resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getType } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	type ApprovalContext,
	type ApprovalResult,
	parseMaxRounds,
	runApprovalGate,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/approval";
import { PHASES } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";

// ---------------------------------------------------------------------------
// Mock ApprovalContext — throws on unexpected calls (empty queue = test bug)
// ---------------------------------------------------------------------------

class MockApprovalCtx implements ApprovalContext {
	#selectQueue: (string | undefined)[] = [];
	#inputQueue: (string | undefined)[] = [];
	selectCalls: { title: string; options: string[] }[] = [];
	inputCalls: { title: string; placeholder?: string }[] = [];

	queueSelect(v: string | undefined): void {
		this.#selectQueue.push(v);
	}
	queueInput(v: string | undefined): void {
		this.#inputQueue.push(v);
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		if (this.#selectQueue.length === 0) throw new Error(`Unexpected select call: "${title}"`);
		return this.#selectQueue.shift();
	}

	async input(title: string, placeholder?: string): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder });
		if (this.#inputQueue.length === 0) throw new Error(`Unexpected input call: "${title}"`);
		return this.#inputQueue.shift();
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

// ---------------------------------------------------------------------------
// parseMaxRounds
// ---------------------------------------------------------------------------

describe("parseMaxRounds", () => {
	test('"3" → 3', () => {
		expect(parseMaxRounds("3")).toBe(3);
	});

	test('"0" → 3 (below minimum)', () => {
		expect(parseMaxRounds("0")).toBe(3);
	});

	test('"-1" → 3 (negative)', () => {
		expect(parseMaxRounds("-1")).toBe(3);
	});

	test('"NaN" → 3', () => {
		expect(parseMaxRounds("NaN")).toBe(3);
	});

	test('"" → 3', () => {
		expect(parseMaxRounds("")).toBe(3);
	});

	test('"abc" → 3', () => {
		expect(parseMaxRounds("abc")).toBe(3);
	});

	test('"5" → 5', () => {
		expect(parseMaxRounds("5")).toBe(5);
	});

	test('"1" → 1 (minimum valid)', () => {
		expect(parseMaxRounds("1")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// coerceValue — tested indirectly via getType (the logic is `raw === "true"`
// for boolean, `Number(raw)` for number, raw for everything else)
// ---------------------------------------------------------------------------

describe("getType — coerceValue targets", () => {
	// These assertions pin the type contract that coerceValue relies on.
	// If SETTINGS_SCHEMA types change, coerceValue would silently break — these catch it.

	test("enabled setting is boolean type", () => {
		expect(getType("workflow.phases.brainstorm.enabled")).toBe("boolean");
	});

	test("approval setting is enum type (string coercion)", () => {
		expect(getType("workflow.phases.brainstorm.approval")).toBe("enum");
	});

	test("reviewAgent setting is enum type (string coercion)", () => {
		expect(getType("workflow.phases.brainstorm.reviewAgent")).toBe("enum");
	});

	test("maxReviewRounds setting is enum type (string coercion, not number)", () => {
		// maxReviewRounds is stored as string enum; parseMaxRounds converts it to number later.
		// coerceValue should NOT produce a number here — it returns the raw string.
		expect(getType("workflow.phases.brainstorm.maxReviewRounds")).toBe("enum");
	});

	test("boolean coercion: 'true' → true, 'false' → false (inline coerceValue logic)", () => {
		// Replicates what coerceValue does for type === "boolean"
		const coerceBoolean = (raw: string): boolean => raw === "true";
		expect(coerceBoolean("true")).toBe(true);
		expect(coerceBoolean("false")).toBe(false);
		// Non-canonical values are also false — the UI only passes canonical strings
		expect(coerceBoolean("1")).toBe(false);
	});

	test("all 7 phases have the same four setting types", () => {
		const suffixTypes: Record<string, string> = {
			enabled: "boolean",
			approval: "enum",
			reviewAgent: "enum",
			maxReviewRounds: "enum",
		};
		for (const phase of PHASES) {
			for (const [suffix, expectedType] of Object.entries(suffixTypes)) {
				const path = `workflow.phases.${phase}.${suffix}` as SettingPath;
				expect(getType(path) as string).toBe(expectedType);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Settings.set (global) propagates to runApprovalGate
// Unlike edge tests which use overrides: {}, this exercises the settings.set() path.
// ---------------------------------------------------------------------------

describe("Settings.set → runApprovalGate propagation", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	test("settings.set approval=none → runApprovalGate auto-approves", async () => {
		settings.set("workflow.phases.brainstorm.approval", "none");

		const ctx = new MockApprovalCtx();
		const result = await runApprovalGate("brainstorm", ctx);

		expect(result.approved).toBe(true);
		expect(ctx.selectCalls).toHaveLength(0);
	});

	test("settings.set approval=agent → returns reviewPrompt without UI", async () => {
		settings.set("workflow.phases.brainstorm.approval", "agent");

		const ctx = new MockApprovalCtx();
		const result = await runApprovalGate("brainstorm", ctx);

		expect(result.approved).toBe(false);
		expect(hasReviewPrompt(result)).toBe(true);
		expect(ctx.selectCalls).toHaveLength(0);
	});

	test("settings.set approval=both → returns reviewPrompt with user note", async () => {
		settings.set("workflow.phases.brainstorm.approval", "both");

		const ctx = new MockApprovalCtx();
		const result = await runApprovalGate("brainstorm", ctx);

		expect(result.approved).toBe(false);
		expect(hasReviewPrompt(result)).toBe(true);
		expect((result as { approved: false; reviewPrompt: string }).reviewPrompt).toContain("user");
	});

	test("settings.set approval=user → calls context.select", async () => {
		settings.set("workflow.phases.brainstorm.approval", "user");

		const ctx = new MockApprovalCtx();
		ctx.queueSelect("Approve");
		const result = await runApprovalGate("brainstorm", ctx);

		expect(result.approved).toBe(true);
		expect(ctx.selectCalls).toHaveLength(1);
	});

	test("override takes precedence over settings.set (global)", async () => {
		// Global says "user" (requires UI), override says "none" (auto-approve).
		settings.set("workflow.phases.brainstorm.approval", "user");
		settings.override("workflow.phases.brainstorm.approval" as SettingPath, "none" as never);

		const ctx = new MockApprovalCtx();
		const result = await runApprovalGate("brainstorm", ctx);

		expect(result.approved).toBe(true);
		expect(ctx.selectCalls).toHaveLength(0);
	});

	test("clearOverride falls back to settings.set value (not schema default)", async () => {
		// Global set to "agent", override to "none", then clear override.
		// After clear: should read the set value ("agent"), not the schema default ("user").
		settings.set("workflow.phases.brainstorm.approval", "agent");
		settings.override("workflow.phases.brainstorm.approval" as SettingPath, "none" as never);

		// With override active: auto-approve
		const ctx1 = new MockApprovalCtx();
		const r1 = await runApprovalGate("brainstorm", ctx1);
		expect(r1.approved).toBe(true);

		// Clear override: falls back to "agent" (set value), not "user" (schema default)
		settings.clearOverride("workflow.phases.brainstorm.approval" as SettingPath);

		const ctx2 = new MockApprovalCtx();
		const r2 = await runApprovalGate("brainstorm", ctx2);
		expect(r2.approved).toBe(false);
		expect(hasReviewPrompt(r2)).toBe(true);
		expect(ctx2.selectCalls).toHaveLength(0);
	});

	test("settings.set on different phases do not interfere", async () => {
		settings.set("workflow.phases.brainstorm.approval", "none");
		settings.set("workflow.phases.spec.approval", "agent");

		// brainstorm still auto-approves
		const ctx1 = new MockApprovalCtx();
		const r1 = await runApprovalGate("brainstorm", ctx1);
		expect(r1.approved).toBe(true);

		// spec still returns reviewPrompt
		const ctx2 = new MockApprovalCtx();
		const r2 = await runApprovalGate("spec", ctx2);
		expect(r2.approved).toBe(false);
		expect(hasReviewPrompt(r2)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Phase enabled setting — read/write via Settings
// ---------------------------------------------------------------------------

describe("workflow.phases.*.enabled — Settings read/write", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	test("all phases default to enabled=true", () => {
		for (const phase of PHASES) {
			const path = `workflow.phases.${phase}.enabled` as SettingPath;
			expect(settings.get(path) as boolean).toBe(true);
		}
	});

	test("settings.set enabled=false is read back as false", () => {
		settings.set("workflow.phases.spec.enabled", false);
		expect(settings.get("workflow.phases.spec.enabled")).toBe(false);
	});

	test("disabling one phase does not affect others", () => {
		settings.set("workflow.phases.spec.enabled", false);

		for (const phase of PHASES) {
			if (phase === "spec") continue;
			const path = `workflow.phases.${phase}.enabled` as SettingPath;
			expect(settings.get(path) as boolean).toBe(true);
		}
	});

	test("override enabled=false takes effect immediately", () => {
		settings.override("workflow.phases.design.enabled" as SettingPath, false as never);
		expect(settings.get("workflow.phases.design.enabled")).toBe(false);
	});

	test("clearOverride restores original enabled value", () => {
		// Start: default true
		expect(settings.get("workflow.phases.design.enabled")).toBe(true);

		settings.override("workflow.phases.design.enabled" as SettingPath, false as never);
		expect(settings.get("workflow.phases.design.enabled")).toBe(false);

		settings.clearOverride("workflow.phases.design.enabled" as SettingPath);
		expect(settings.get("workflow.phases.design.enabled")).toBe(true);
	});

	test("init override sets enabled=false for a phase", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "workflow.phases.plan.enabled": false },
		});

		expect(settings.get("workflow.phases.plan.enabled")).toBe(false);
		// Other phases unaffected
		expect(settings.get("workflow.phases.brainstorm.enabled")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Default settings — all phases have well-defined defaults
// ---------------------------------------------------------------------------

describe("default workflow settings", () => {
	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	test("default approval mode is 'user' for all phases", () => {
		for (const phase of PHASES) {
			const path = `workflow.phases.${phase}.approval` as SettingPath;
			expect(settings.get(path) as string).toBe("user");
		}
	});

	test("default reviewAgent is 'critic' for all phases", () => {
		for (const phase of PHASES) {
			const path = `workflow.phases.${phase}.reviewAgent` as SettingPath;
			expect(settings.get(path) as string).toBe("critic");
		}
	});

	test("default maxReviewRounds is '3' (string enum) for all phases", () => {
		for (const phase of PHASES) {
			const path = `workflow.phases.${phase}.maxReviewRounds` as SettingPath;
			// Stored as string enum; parseMaxRounds("3") → 3
			expect(settings.get(path) as string).toBe("3");
			expect(parseMaxRounds(settings.get(path) as string)).toBe(3);
		}
	});

	test("default settings produce auto-user-approval pipeline (calls context.select)", async () => {
		// With all defaults (approval=user), each phase calls the context
		const ctx = new MockApprovalCtx();
		ctx.queueSelect("Approve");
		const result = await runApprovalGate("execute", ctx);

		expect(result.approved).toBe(true);
		expect(ctx.selectCalls).toHaveLength(1);
	});
});
