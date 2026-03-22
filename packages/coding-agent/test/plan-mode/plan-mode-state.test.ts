import { describe, expect, it } from "bun:test";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import { currentStage, isLastStage, stageFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/state";

describe("stageFilePath", () => {
	it("returns uppercase local:// URL for each stage", () => {
		expect(stageFilePath("understand")).toBe("local://UNDERSTAND.md");
		expect(stageFilePath("design")).toBe("local://DESIGN.md");
		expect(stageFilePath("review")).toBe("local://REVIEW.md");
		expect(stageFilePath("plan")).toBe("local://PLAN.md");
	});
});

describe("isLastStage", () => {
	it("returns true when no stages array (single-stage backward compat)", () => {
		const state: PlanModeState = { enabled: true, planFilePath: "local://PLAN.md" };
		expect(isLastStage(state)).toBe(true);
	});

	it("returns true when stages array is empty", () => {
		const state: PlanModeState = { enabled: true, planFilePath: "x", stages: [], currentStageIndex: 0 };
		expect(isLastStage(state)).toBe(true);
	});

	it("returns true for single-element stages at index 0", () => {
		const state: PlanModeState = { enabled: true, planFilePath: "x", stages: ["plan"], currentStageIndex: 0 };
		expect(isLastStage(state)).toBe(true);
	});

	it("returns false when not at last position in multi-stage", () => {
		const state: PlanModeState = {
			enabled: true,
			planFilePath: "x",
			stages: ["understand", "plan"],
			currentStageIndex: 0,
		};
		expect(isLastStage(state)).toBe(false);
	});

	it("returns true when at last position in multi-stage", () => {
		const state: PlanModeState = {
			enabled: true,
			planFilePath: "x",
			stages: ["understand", "plan"],
			currentStageIndex: 1,
		};
		expect(isLastStage(state)).toBe(true);
	});

	it("returns true when currentStageIndex is undefined (defaults to 0) and stages has 1 element", () => {
		const state: PlanModeState = { enabled: true, planFilePath: "x", stages: ["plan"] };
		expect(isLastStage(state)).toBe(true);
	});
});

describe("currentStage", () => {
	it("returns 'plan' when no stages array (backward compat)", () => {
		const state: PlanModeState = { enabled: true, planFilePath: "x" };
		expect(currentStage(state)).toBe("plan");
	});

	it("returns the stage at currentStageIndex", () => {
		const state: PlanModeState = {
			enabled: true,
			planFilePath: "x",
			stages: ["understand", "design", "plan"],
			currentStageIndex: 1,
		};
		expect(currentStage(state)).toBe("design");
	});

	it("defaults to index 0 when currentStageIndex is undefined", () => {
		const state: PlanModeState = {
			enabled: true,
			planFilePath: "x",
			stages: ["understand", "plan"],
		};
		expect(currentStage(state)).toBe("understand");
	});
});
