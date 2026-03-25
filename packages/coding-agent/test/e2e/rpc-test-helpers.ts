/**
 * Shared helpers for RPC E2E tests.
 *
 * Design principles:
 * - No dumb timeouts. Detect stuck states immediately.
 * - Track events actively. If agent_end fires without exit_plan_mode, that's detectable.
 * - Activity watchdog: no events for N seconds = stuck = fail fast.
 * - Max 5 minutes per test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../utilities";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MINIMAX_API_KEY = e2eApiKey("MINIMAX_CODE_API_KEY");
export const CLI_PATH = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

/** Max silence before declaring a test stuck (no events received). */
const ACTIVITY_TIMEOUT_MS = 60_000;

/** Max total time for a single phase turn (including nudges). */
const PHASE_TURN_MAX_MS = 290_000;

/** Wait after agent_end for async approval + artifact writes. */
const POST_TURN_SETTLE_MS = 3_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtensionUIHandler = (request: RpcExtensionUIRequest) => Partial<RpcExtensionUIResponse> | null;

export interface PhaseResult {
	events: AgentEvent[];
	toolsCalled: string[];
	calledExitPlanMode: boolean;
	approvalShown: boolean;
	continueShown: boolean;
}

// ---------------------------------------------------------------------------
// Auto-approve handler
// ---------------------------------------------------------------------------

export function createAutoApproveHandler(): ExtensionUIHandler {
	return (request: RpcExtensionUIRequest) => {
		if (request.method === "select") {
			const options = request.options as string[] | undefined;
			if (!options?.length) return { cancelled: true };
			if (options.includes("Approve")) return { value: "Approve" };
			if (options.includes("Accept")) return { value: "Accept" };
			if (options.includes("Continue")) return { value: "Continue" };
			if (options.includes("Overwrite")) return { value: "Overwrite" };
			if (options.includes("Yes, switch")) return { value: "Yes, switch" };
			if (options.includes("Yes")) return { value: "Yes" };
			if (options.includes("Yes, delete")) return { value: "Yes, delete" };
			return { value: options[0] };
		}
		if (request.method === "input") {
			const placeholder = (request as { placeholder?: string }).placeholder;
			return { value: placeholder || "test-input" };
		}
		if (request.method === "confirm") return { confirmed: true };
		return null;
	};
}

// ---------------------------------------------------------------------------
// Smart event collector with activity watchdog
// ---------------------------------------------------------------------------

/**
 * Wait for an agent turn to complete. Fails fast on:
 * - No activity for ACTIVITY_TIMEOUT_MS (stuck agent)
 * - Total time exceeds maxMs
 *
 * Returns all events collected during the turn.
 */
export async function waitForTurnEnd(client: RpcClient, maxMs = PHASE_TURN_MAX_MS): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
	let settled = false;

	const totalTimeout = setTimeout(() => {
		if (settled) return;
		settled = true;
		const toolsUsed = events.filter(e => e.type === "tool_execution_start").map(e => e.toolName);
		reject(
			new Error(
				`Agent turn exceeded ${maxMs / 1000}s. ` +
					`Events: ${events.length}, tools: [${toolsUsed.join(", ")}]. ` +
					`Last event: ${events.at(-1)?.type ?? "none"}`,
			),
		);
	}, maxMs);

	let activityTimer = setTimeout(() => {
		if (settled) return;
		settled = true;
		clearTimeout(totalTimeout);
		reject(
			new Error(
				`No activity for ${ACTIVITY_TIMEOUT_MS / 1000}s — agent appears stuck. ` +
					`Events so far: ${events.length}, last: ${events.at(-1)?.type ?? "none"}`,
			),
		);
	}, ACTIVITY_TIMEOUT_MS);

	const remove = client.onEvent((event: AgentEvent) => {
		events.push(event);

		// Reset activity watchdog on every event
		clearTimeout(activityTimer);
		activityTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			clearTimeout(totalTimeout);
			reject(
				new Error(
					`No activity for ${ACTIVITY_TIMEOUT_MS / 1000}s — agent appears stuck. ` +
						`Events: ${events.length}, last: ${events.at(-1)?.type ?? "none"}`,
				),
			);
		}, ACTIVITY_TIMEOUT_MS);

		if (event.type === "agent_end") {
			clearTimeout(totalTimeout);
			clearTimeout(activityTimer);
			if (!settled) {
				settled = true;
				remove();
				resolve(events);
			}
		}
	});

	return promise;
}

/**
 * Run a full workflow phase turn:
 * 1. Send prompt
 * 2. Wait for agent_end
 * 3. If exit_plan_mode wasn't called, nudge once
 * 4. Wait for async approval + artifact writes
 * 5. Return structured result
 */
export async function runPhaseTurn(
	client: RpcClient,
	prompt: string,
	uiRequests: RpcExtensionUIRequest[],
	phase: string,
	slug: string,
): Promise<PhaseResult> {
	let events = await sendAndWait(client, prompt);
	const toolsCalled = events.filter(e => e.type === "tool_execution_start").map(e => e.toolName ?? "unknown");
	let calledExitPlanMode = toolsCalled.includes("exit_plan_mode");

	// If agent didn't call exit_plan_mode, nudge once
	if (!calledExitPlanMode) {
		const nudgeEvents = await sendAndWait(
			client,
			`You MUST now call exit_plan_mode to complete the ${phase} phase. ` +
				`First write to local://${phase.toUpperCase()}.md, then call exit_plan_mode ` +
				`with title: ${phase.toUpperCase()}, workflowSlug: ${slug}, workflowPhase: ${phase}.`,
		);
		events = [...events, ...nudgeEvents];
		const nudgeTools = nudgeEvents.filter(e => e.type === "tool_execution_start").map(e => e.toolName ?? "unknown");
		toolsCalled.push(...nudgeTools);
		calledExitPlanMode = nudgeTools.includes("exit_plan_mode");
	}

	// Wait for async approval gate + artifact persistence
	await Bun.sleep(POST_TURN_SETTLE_MS);

	const approvalShown = uiRequests.some(
		r => r.method === "select" && (r.options as string[] | undefined)?.includes("Approve"),
	);
	const continueShown = uiRequests.some(
		r => r.method === "select" && (r.options as string[] | undefined)?.includes("Continue"),
	);

	return { events, toolsCalled, calledExitPlanMode, approvalShown, continueShown };
}

async function sendAndWait(client: RpcClient, prompt: string): Promise<AgentEvent[]> {
	const eventsPromise = waitForTurnEnd(client);
	client.prompt(prompt);
	return eventsPromise;
}

// ---------------------------------------------------------------------------
// Notification collector (for info-only commands)
// ---------------------------------------------------------------------------

/**
 * Send a command that doesn't start an agent turn and collect notifications.
 * Returns as soon as a notification arrives, or after maxWaitMs.
 */
export async function sendAndCollectNotifications(
	client: RpcClient,
	command: string,
	maxWaitMs = 10_000,
): Promise<RpcExtensionUIRequest[]> {
	const notifications: RpcExtensionUIRequest[] = [];
	const { promise, resolve } = Promise.withResolvers<RpcExtensionUIRequest[]>();
	let settled = false;

	const timeout = setTimeout(() => {
		if (!settled) {
			settled = true;
			remove();
			resolve(notifications);
		}
	}, maxWaitMs);

	// Resolve early once we get a notification (with a small buffer for more)
	const remove = client.onExtensionUIRequest((req: RpcExtensionUIRequest) => {
		notifications.push(req);
		// Wait 1s for any additional notifications after the first one
		clearTimeout(timeout);
		setTimeout(() => {
			if (!settled) {
				settled = true;
				remove();
				resolve(notifications);
			}
		}, 1000);
	});

	await client.prompt(command);
	return promise;
}

// ---------------------------------------------------------------------------
// Extension UI handler attachment
// ---------------------------------------------------------------------------

export function attachAutoApprove(client: RpcClient, uiRequests?: RpcExtensionUIRequest[]): () => void {
	const handler = createAutoApproveHandler();
	return client.onExtensionUIRequest((request: RpcExtensionUIRequest) => {
		uiRequests?.push(request);
		const response = handler(request);
		if (response && request.id) {
			client.sendExtensionUIResponse({ id: request.id, ...response } as never);
		}
	});
}

// ---------------------------------------------------------------------------
// Workflow seeding
// ---------------------------------------------------------------------------

export function seedWorkflow(workDir: string, slug: string, completedPhases: string[]): void {
	const wfDir = path.join(workDir, "docs", "workflow", slug);
	fs.mkdirSync(wfDir, { recursive: true });
	const artifacts: Record<string, string> = {};
	for (const phase of completedPhases) {
		artifacts[phase] = `docs/workflow/${slug}/${phase}.md`;
		fs.writeFileSync(
			path.join(wfDir, `${phase}.md`),
			`# ${phase}\nTest artifact for ${phase} phase.\nThis is a simple calculator app.`,
		);
	}
	fs.writeFileSync(
		path.join(wfDir, "state.json"),
		JSON.stringify({
			slug,
			currentPhase: completedPhases.at(-1) ?? "brainstorm",
			artifacts,
		}),
	);
	fs.writeFileSync(path.join(workDir, "docs", "workflow", ".active"), slug);
}

// ---------------------------------------------------------------------------
// Test environment setup/teardown
// ---------------------------------------------------------------------------

export interface RpcTestEnv {
	client: RpcClient;
	sessionDir: string;
	workDir: string;
	cleanup(): void;
}

export function createRpcTestEnv(): RpcTestEnv {
	const sessionDir = path.join(os.tmpdir(), `omp-rpc-${Snowflake.next()}`);
	const workDir = path.join(os.tmpdir(), `omp-work-${Snowflake.next()}`);
	fs.mkdirSync(workDir, { recursive: true });

	const client = new RpcClient({
		cliPath: CLI_PATH,
		cwd: workDir,
		env: {
			PI_CODING_AGENT_DIR: sessionDir,
			MINIMAX_CODE_API_KEY: MINIMAX_API_KEY!,
		},
		provider: "minimax-code",
		model: "MiniMax-M2.7",
	});

	return {
		client,
		sessionDir,
		workDir,
		cleanup() {
			client.stop();
			for (const dir of [sessionDir, workDir]) {
				if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export function readWorkflowState(workDir: string, slug: string): Record<string, unknown> {
	const stateFile = path.join(workDir, "docs", "workflow", slug, "state.json");
	return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

export function workflowDirExists(workDir: string, slug: string): boolean {
	return fs.existsSync(path.join(workDir, "docs", "workflow", slug));
}

export function artifactExists(workDir: string, slug: string, phase: string): boolean {
	return fs.existsSync(path.join(workDir, "docs", "workflow", slug, `${phase}.md`));
}

export function detectSlug(workDir: string): string {
	const wfDir = path.join(workDir, "docs", "workflow");
	const dirs = fs.readdirSync(wfDir).filter(f => {
		try {
			return fs.statSync(path.join(wfDir, f)).isDirectory();
		} catch {
			return false;
		}
	});
	if (dirs.length !== 1) throw new Error(`Expected 1 workflow dir, found ${dirs.length}: [${dirs.join(", ")}]`);
	return dirs[0]!;
}
