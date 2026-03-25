/**
 * RPC E2E: Individual phase tests (spec through finish).
 * Flowchart sections: 7 (subsequent phases), 4-6 (completion flow), 10 (dependencies).
 *
 * Each test pre-seeds prerequisite artifacts, runs one phase through the full
 * completion flow (agent turn → exit_plan_mode → approval → artifact persist),
 * and verifies the contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	artifactExists,
	attachAutoApprove,
	createRpcTestEnv,
	MINIMAX_API_KEY,
	type RpcTestEnv,
	readWorkflowState,
	runPhaseTurn,
	seedWorkflow,
} from "./rpc-test-helpers";

/** Phase prerequisite map — what must exist before each phase can run. */
const PREREQS: Record<string, string[]> = {
	spec: ["brainstorm"],
	design: ["brainstorm", "spec"],
	plan: ["brainstorm", "spec", "design"],
	execute: ["brainstorm", "spec", "design", "plan"],
	verify: ["brainstorm", "spec", "design", "plan", "execute"],
	finish: ["brainstorm", "spec", "design", "plan", "execute", "verify"],
};

describe.skipIf(!MINIMAX_API_KEY)("RPC individual phases", () => {
	let env: RpcTestEnv;

	beforeEach(() => {
		env = createRpcTestEnv();
	});
	afterEach(() => env.cleanup());

	for (const [phase, prereqs] of Object.entries(PREREQS)) {
		const isPreImpl = ["spec", "design", "plan"].includes(phase);

		test(`${phase}: prereqs → agent turn → approval → artifact`, async () => {
			await env.client.start();
			const uiRequests: RpcExtensionUIRequest[] = [];
			attachAutoApprove(env.client, uiRequests);

			const slug = `test-${phase}-slug`;
			seedWorkflow(env.workDir, slug, prereqs);

			const result = await runPhaseTurn(env.client, `/workflow ${phase} ${slug}`, uiRequests, phase, slug);

			// Agent ran
			expect(result.events.some(e => e.type === "agent_start")).toBe(true);

			// exit_plan_mode called
			expect(result.calledExitPlanMode).toBe(true);

			// Approval gate fired
			expect(result.approvalShown).toBe(true);

			// Artifact persisted
			expect(artifactExists(env.workDir, slug, phase)).toBe(true);
			const state = readWorkflowState(env.workDir, slug);
			expect((state.artifacts as Record<string, string>)?.[phase]).toBeDefined();

			// Pre-implementation phases also get "Continue to next?"
			if (isPreImpl) {
				expect(result.continueShown).toBe(true);
			}
		}, 300_000);
	}
});
