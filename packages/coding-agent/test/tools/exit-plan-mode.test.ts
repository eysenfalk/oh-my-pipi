import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ExitPlanModeTool } from "@oh-my-pi/pi-coding-agent/tools/exit-plan-mode";

describe("ExitPlanModeTool", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-mode-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
		await Bun.write(path.join(artifactsDir, "local", "PLAN.md"), "# Plan\n");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-a",
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			...overrides,
		};
	}

	it("title is optional in schema (not required for intermediate stages)", () => {
		const tool = new ExitPlanModeTool(createSession());
		const schema = tool.parameters as { required?: string[] };
		// title is optional — only required for the final stage
		expect(schema.required ?? []).not.toContain("title");
	});

	it("normalizes title to .md final plan path", async () => {
		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-1", { title: "WP_MIGRATION_PLAN" });

		expect(result.details?.planFilePath).toBe("local://PLAN.md");
		expect(result.details?.title).toBe("WP_MIGRATION_PLAN");
		expect(result.details?.finalPlanFilePath).toBe("local://WP_MIGRATION_PLAN.md");
		expect(result.details?.planExists).toBe(true);
		expect(result.details?.isIntermediate).toBe(false);
		expect(result.details?.currentStage).toBe("plan");
	});

	it("accepts explicit .md suffix in title", async () => {
		const tool = new ExitPlanModeTool(createSession());
		const result = await tool.execute("call-2", { title: "WP_MIGRATION_PLAN.md" });
		expect(result.details?.title).toBe("WP_MIGRATION_PLAN");
		expect(result.details?.finalPlanFilePath).toBe("local://WP_MIGRATION_PLAN.md");
	});

	it("fails early when the draft plan file was never written", async () => {
		await fs.rm(path.join(artifactsDir, "local", "PLAN.md"), { force: true });
		const tool = new ExitPlanModeTool(createSession());

		await expect(tool.execute("call-missing", { title: "WP_MIGRATION_PLAN" })).rejects.toThrow(
			"Stage file not found at local://PLAN.md. Write the stage output to local://PLAN.md before calling exit_plan_mode.",
		);
	});

	it("rejects invalid title characters", async () => {
		const tool = new ExitPlanModeTool(createSession());
		await expect(tool.execute("call-3", { title: "../bad" })).rejects.toThrow(
			"Title must not contain path separators or '..'.",
		);
		await expect(tool.execute("call-4", { title: "bad name" })).rejects.toThrow(
			"Title may only contain letters, numbers, underscores, or hyphens.",
		);
	});
	it("intermediate stage: succeeds without title, sets isIntermediate: true", async () => {
		// Two-stage mode: understand -> plan, currently at 'understand' (index 0, not last)
		const session = createSession({
			getPlanModeState: () => ({
				enabled: true,
				planFilePath: "local://UNDERSTAND.md",
				stages: ["understand", "plan"] as const,
				currentStageIndex: 0,
			}),
		});
		await Bun.write(path.join(artifactsDir, "local", "UNDERSTAND.md"), "# Understanding\n");

		const tool = new ExitPlanModeTool(session);
		const result = await tool.execute("tc-1", {});

		expect(result.details?.isIntermediate).toBe(true);
		expect(result.details?.currentStage).toBe("understand");
		expect(result.details?.title).toBeUndefined();
		expect(result.details?.finalPlanFilePath).toBeUndefined();
	});

	it("final stage: requires title", async () => {
		// Two-stage mode, currently at 'plan' (index 1, which IS last)
		const session = createSession({
			getPlanModeState: () => ({
				enabled: true,
				planFilePath: "local://PLAN.md",
				stages: ["understand", "plan"] as const,
				currentStageIndex: 1,
			}),
		});

		const tool = new ExitPlanModeTool(session);
		await expect(tool.execute("tc-2", {})).rejects.toThrow("Title is required for the final plan stage");

		const result = await tool.execute("tc-2b", { title: "MY_PLAN" });
		expect(result.details?.isIntermediate).toBe(false);
		expect(result.details?.title).toBe("MY_PLAN");
		expect(result.details?.finalPlanFilePath).toBe("local://MY_PLAN.md");
	});

	it("single-stage mode (no stages array): title required, isIntermediate: false", async () => {
		// Legacy single-stage: no stages array, isLastStage returns true
		const session = createSession({
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
		});

		const tool = new ExitPlanModeTool(session);
		const result = await tool.execute("tc-3", { title: "LEGACY_PLAN" });
		expect(result.details?.isIntermediate).toBe(false);
		expect(result.details?.currentStage).toBe("plan");
	});
});
