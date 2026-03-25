/**
 * RPC E2E: Brainstorm phase — full lifecycle.
 * Flowchart sections: 2a, 2b, 3, 4, 5, 5a, 6.
 *
 * Tests the brainstorm flow end-to-end:
 * - /workflow brainstorm <topic> → slug confirmation → agent turn → exit_plan_mode
 * - Approval gate fires → auto-approve → artifact persisted
 * - "Continue to next?" selector shown → state.json updated
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	artifactExists,
	attachAutoApprove,
	createRpcTestEnv,
	detectSlug,
	MINIMAX_API_KEY,
	type RpcTestEnv,
	readWorkflowState,
	runPhaseTurn,
} from "./rpc-test-helpers";

describe.skipIf(!MINIMAX_API_KEY)("RPC brainstorm phase", () => {
	let env: RpcTestEnv;

	beforeEach(() => {
		env = createRpcTestEnv();
	});
	afterEach(() => env.cleanup());

	test("brainstorm: slug dialog + agent turn + approval + artifact", async () => {
		await env.client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		attachAutoApprove(env.client, uiRequests);

		const result = await runPhaseTurn(
			env.client,
			"/workflow brainstorm simple calculator app",
			uiRequests,
			"brainstorm",
			"", // slug unknown yet, nudge will use empty — but the active workflow handles it
		);

		// Agent ran
		expect(result.events.some(e => e.type === "agent_start")).toBe(true);

		// Slug confirmation dialog shown with recommended name
		const slugInput = uiRequests.find(r => r.method === "input");
		expect(slugInput).toBeDefined();
		const placeholder = (slugInput as { placeholder?: string }).placeholder;
		expect(placeholder).toBeDefined();
		expect(placeholder!).toMatch(/^\d{4}-\d{2}-\d{2}-simple-calculator/);

		// Detect slug from filesystem
		const slug = detectSlug(env.workDir);
		expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-/);

		// exit_plan_mode was called (directly or after nudge)
		expect(result.calledExitPlanMode).toBe(true);

		// Approval gate fired
		expect(result.approvalShown).toBe(true);

		// "Continue to next?" shown
		expect(result.continueShown).toBe(true);

		// Artifact persisted
		const state = readWorkflowState(env.workDir, slug);
		expect(state.slug).toBe(slug);
		expect((state.artifacts as Record<string, string>)?.brainstorm).toBeDefined();
		expect(artifactExists(env.workDir, slug, "brainstorm")).toBe(true);
	}, 300_000);
});
