import { mock } from "bun:test";

// Mock the native addon before any transitive import evaluates it.
// enforceWriteGuard has no runtime dependency on TUI or native code; the
// native module is only pulled in via the internal-urls barrel → render-utils
// → @oh-my-pi/pi-tui. A stub here keeps the test isolated from the build env.
mock.module("@oh-my-pi/pi-natives", () => ({}));

import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforceWriteGuard } from "@oh-my-pi/pi-coding-agent/tools/write-guard";

function mockSession(overrides: Partial<ToolSession>): ToolSession {
	return {
		cwd: "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getArtifactsDir: () => "/tmp/artifacts",
		getSessionId: () => "test-session",
		...overrides,
	} as unknown as ToolSession;
}

describe("enforceWriteGuard", () => {
	describe("normal mode (no plan, no read-only)", () => {
		it("allows writes to any file", () => {
			const session = mockSession({
				getReadOnlyMode: () => false,
				getPlanModeState: () => undefined,
			});
			expect(() => enforceWriteGuard(session, "src/main.ts")).not.toThrow();
			expect(() => enforceWriteGuard(session, "local://PLAN.md")).not.toThrow();
		});
	});

	describe("read-only mode", () => {
		it("blocks writes to any file", () => {
			const session = mockSession({
				getReadOnlyMode: () => true,
				getPlanModeState: () => undefined,
			});
			expect(() => enforceWriteGuard(session, "src/main.ts")).toThrow("Read-only mode");
		});

		it("blocks writes even to the plan file", () => {
			const session = mockSession({
				getReadOnlyMode: () => true,
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			});
			expect(() => enforceWriteGuard(session, "local://PLAN.md")).toThrow("Read-only mode");
		});
	});

	describe("plan mode", () => {
		it("allows writes to the current stage file", () => {
			const session = mockSession({
				getReadOnlyMode: () => false,
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			});
			expect(() => enforceWriteGuard(session, "local://PLAN.md")).not.toThrow();
		});

		it("blocks writes to files other than the current stage file", () => {
			const session = mockSession({
				getReadOnlyMode: () => false,
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			});
			expect(() => enforceWriteGuard(session, "src/main.ts")).toThrow("Plan mode");
		});

		it("blocks write to wrong stage file when in multi-stage mode", () => {
			const session = mockSession({
				getReadOnlyMode: () => false,
				getPlanModeState: () => ({
					enabled: true,
					planFilePath: "local://UNDERSTAND.md",
					stages: ["understand", "plan"] as const,
					currentStageIndex: 0,
				}),
			});
			expect(() => enforceWriteGuard(session, "local://PLAN.md")).toThrow("Plan mode");
			expect(() => enforceWriteGuard(session, "local://UNDERSTAND.md")).not.toThrow();
		});

		it("blocks moves and deletes", () => {
			const session = mockSession({
				getReadOnlyMode: () => false,
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			});
			expect(() => enforceWriteGuard(session, "local://PLAN.md", { move: "other.md" })).toThrow("renaming");
			expect(() => enforceWriteGuard(session, "local://PLAN.md", { op: "delete" })).toThrow("deleting");
		});
	});

	describe("read-only takes precedence over plan mode", () => {
		it("throws read-only error even when the stage file matches", () => {
			const session = mockSession({
				getReadOnlyMode: () => true,
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://PLAN.md" }),
			});
			expect(() => enforceWriteGuard(session, "local://PLAN.md")).toThrow("Read-only mode");
		});
	});

	describe("backward compat: optional getReadOnlyMode", () => {
		it("does not throw when getReadOnlyMode is absent (not in interface)", () => {
			const session = mockSession({
				// No getReadOnlyMode — simulates old ToolSession without the method
				getPlanModeState: () => undefined,
			});
			expect(() => enforceWriteGuard(session, "src/main.ts")).not.toThrow();
		});
	});
});
