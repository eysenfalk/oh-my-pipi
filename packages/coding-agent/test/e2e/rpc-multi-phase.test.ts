/**
 * RPC E2E: Multi-phase flow tests.
 * Flowchart sections: 2-7 (full lifecycle), 6 (continue to next).
 *
 * Tests the chain: brainstorm → approve → continue → spec → approve → continue...
 * In RPC mode, "Continue" selects editor text but doesn't auto-submit.
 * The test manually sends each subsequent `/workflow <phase> <slug>` command.
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

const _PHASES = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"] as const;

describe.skipIf(!MINIMAX_API_KEY)("RPC multi-phase flow", () => {
	let env: RpcTestEnv;

	beforeEach(() => {
		env = createRpcTestEnv();
	});
	afterEach(() => env.cleanup());

	test("brainstorm → spec: two-phase chain with auto-approve", async () => {
		await env.client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		attachAutoApprove(env.client, uiRequests);

		// Phase 1: brainstorm
		const brainstormResult = await runPhaseTurn(
			env.client,
			"/workflow brainstorm simple calculator app",
			uiRequests,
			"brainstorm",
			"",
		);
		expect(brainstormResult.calledExitPlanMode).toBe(true);
		expect(brainstormResult.approvalShown).toBe(true);
		expect(brainstormResult.continueShown).toBe(true);

		const slug = detectSlug(env.workDir);
		expect(artifactExists(env.workDir, slug, "brainstorm")).toBe(true);

		// Phase 2: spec (manually send — RPC doesn't auto-submit editor text)
		uiRequests.length = 0; // Reset for clean assertions
		const specResult = await runPhaseTurn(env.client, `/workflow spec ${slug}`, uiRequests, "spec", slug);
		expect(specResult.calledExitPlanMode).toBe(true);
		expect(specResult.approvalShown).toBe(true);

		// Both artifacts on disk
		expect(artifactExists(env.workDir, slug, "brainstorm")).toBe(true);
		expect(artifactExists(env.workDir, slug, "spec")).toBe(true);

		// state.json records both
		const state = readWorkflowState(env.workDir, slug);
		const artifacts = state.artifacts as Record<string, string>;
		expect(artifacts.brainstorm).toBeDefined();
		expect(artifacts.spec).toBeDefined();
	}, 300_000);
});
