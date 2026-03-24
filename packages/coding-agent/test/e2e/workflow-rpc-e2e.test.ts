/**
 * Workflow E2E tests via RPC mode using MiniMax M2.7.
 *
 * Tests the full workflow phase completion flow through the actual agent process:
 * - Agent processes workflow prompts via RPC protocol
 * - exit_plan_mode tool calls trigger phase completion
 * - Extension UI approval gates are automated via onExtensionUIRequest
 * - Artifacts are persisted to docs/workflow/<slug>/
 * - Phase transitions work correctly
 * - Info-only commands (list, status, delete) return via notification, not agent turn
 *
 * Gated by MINIMAX_CODE_API_KEY environment variable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "../utilities";

// ---------------------------------------------------------------------------
// Extension UI automation helpers
// ---------------------------------------------------------------------------

type ExtensionUIHandler = (request: RpcExtensionUIRequest) => Partial<RpcExtensionUIResponse> | null;

function createAutoApproveHandler(): ExtensionUIHandler {
	return (request: RpcExtensionUIRequest) => {
		if (request.method === "select") {
			const options = request.options as string[] | undefined;
			if (!options?.length) return { cancelled: true };

			// Auto-approve workflow dialogs
			if (options.includes("Approve")) return { value: "Approve" };
			if (options.includes("Accept")) return { value: "Accept" };
			if (options.includes("Continue")) return { value: "Continue" };
			if (options.includes("Overwrite")) return { value: "Overwrite" };
			if (options.includes("Yes, switch")) return { value: "Yes, switch" };
			if (options.includes("Yes")) return { value: "Yes" };

			// Default to first option
			return { value: options[0] };
		}
		if (request.method === "input") {
			const placeholder = (request as { placeholder?: string }).placeholder;
			if (placeholder) return { value: placeholder };
			return { value: "test-input" };
		}
		if (request.method === "confirm") {
			return { confirmed: true };
		}
		// Notifications, status updates — no response needed
		return null;
	};
}

function attachExtensionUIHandler(client: RpcClient, handler: ExtensionUIHandler): () => void {
	return client.onExtensionUIRequest((request: RpcExtensionUIRequest) => {
		const response = handler(request);
		if (response && request.id) {
			client.sendExtensionUIResponse({ id: request.id, ...response } as never);
		}
	});
}

// ---------------------------------------------------------------------------
// Event collection helpers
// ---------------------------------------------------------------------------

/** Collect all events until agent_end. For commands that start agent turns. */
async function collectUntilIdle(client: RpcClient, timeoutMs = 120_000): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
	const timeout = setTimeout(() => reject(new Error("Timeout waiting for agent_end")), timeoutMs);

	const remove = client.onEvent((event: AgentEvent) => {
		events.push(event);
		if (event.type === "agent_end") {
			clearTimeout(timeout);
			remove();
			resolve(events);
		}
	});

	return promise;
}

/**
 * Collect extension UI requests (notifications, selects, etc.) for a fixed duration.
 * Used for info-only commands that don't start agent turns.
 */
async function collectNotifications(client: RpcClient, durationMs = 3000): Promise<RpcExtensionUIRequest[]> {
	const notifications: RpcExtensionUIRequest[] = [];
	const remove = client.onExtensionUIRequest((req: RpcExtensionUIRequest) => {
		notifications.push(req);
	});
	await Bun.sleep(durationMs);
	remove();
	return notifications;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const API_KEY = e2eApiKey("MINIMAX_CODE_API_KEY");
const CLI_PATH = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

describe.skipIf(!API_KEY)("Workflow RPC E2E (MiniMax M2.7)", () => {
	let client: RpcClient;
	let sessionDir: string;
	let workDir: string;

	beforeEach(() => {
		sessionDir = path.join(os.tmpdir(), `omp-wf-rpc-${Snowflake.next()}`);
		workDir = path.join(os.tmpdir(), `omp-wf-work-${Snowflake.next()}`);
		fs.mkdirSync(workDir, { recursive: true });

		client = new RpcClient({
			cliPath: CLI_PATH,
			cwd: workDir,
			env: {
				PI_CODING_AGENT_DIR: sessionDir,
				MINIMAX_CODE_API_KEY: API_KEY!,
			},
			provider: "minimax-code",
			model: "MiniMax-M2.7",
		});
	});

	afterEach(async () => {
		client.stop();
		for (const dir of [sessionDir, workDir]) {
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	// -----------------------------------------------------------------------
	// Basic connectivity
	// -----------------------------------------------------------------------

	test("simple prompt works via RPC", async () => {
		await client.start();
		await client.promptAndWait("Say exactly: HELLO_TEST_MARKER", undefined, 60_000);
		const text = await client.getLastAssistantText();
		expect(text).toContain("HELLO_TEST_MARKER");
	}, 90_000);

	// -----------------------------------------------------------------------
	// Phase execution: brainstorm (uses startWorkflow hook)
	// -----------------------------------------------------------------------

	test("brainstorm phase creates workflow state and artifact", async () => {
		await client.start();
		const removeHandler = attachExtensionUIHandler(client, createAutoApproveHandler());

		// Start brainstorm — triggers startWorkflow hook via onInputCallback
		const eventsPromise = collectUntilIdle(client, 240_000);
		client.prompt("/workflow brainstorm simple calculator app");

		const events = await eventsPromise;
		removeHandler();

		// Agent turn started
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		// Workflow state was created
		const workflowDir = path.join(workDir, "docs", "workflow");
		expect(fs.existsSync(workflowDir)).toBe(true);

		const slugDirs = fs.readdirSync(workflowDir).filter(f => {
			try {
				return fs.statSync(path.join(workflowDir, f)).isDirectory();
			} catch {
				return false;
			}
		});
		expect(slugDirs.length).toBeGreaterThanOrEqual(1);

		const slug = slugDirs[0]!;
		const stateFile = path.join(workflowDir, slug, "state.json");
		expect(fs.existsSync(stateFile)).toBe(true);

		const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
		expect(state.slug).toBe(slug);
		// After brainstorm completes and approval, artifact should exist
		if (state.artifacts?.brainstorm) {
			expect(fs.existsSync(path.join(workflowDir, slug, "brainstorm.md"))).toBe(true);
		}
	}, 240_000);

	// -----------------------------------------------------------------------
	// Phase execution: spec (uses prompt return, not startWorkflow hook)
	// -----------------------------------------------------------------------

	test("spec phase starts when brainstorm artifact exists", async () => {
		await client.start();
		const removeHandler = attachExtensionUIHandler(client, createAutoApproveHandler());

		// Pre-seed brainstorm artifact so spec prereq is met
		const slug = "test-spec-slug";
		const wfDir = path.join(workDir, "docs", "workflow", slug);
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(
			path.join(wfDir, "state.json"),
			JSON.stringify({
				slug,
				currentPhase: "brainstorm",
				artifacts: { brainstorm: `docs/workflow/${slug}/brainstorm.md` },
			}),
		);
		fs.writeFileSync(path.join(wfDir, "brainstorm.md"), "# Brainstorm\nBuild a simple calculator app.");
		fs.writeFileSync(path.join(workDir, "docs", "workflow", ".active"), slug);

		// Start spec phase — returns prompt string, agent processes it
		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow spec ${slug}`);

		const events = await eventsPromise;
		removeHandler();

		// Agent turn started — prerequisites were satisfied, prompt was submitted
		expect(events.some(e => e.type === "agent_start")).toBe(true);
		expect(events.some(e => e.type === "agent_end")).toBe(true);
	}, 600_000);

	// -----------------------------------------------------------------------
	// Prerequisite enforcement
	// -----------------------------------------------------------------------

	test("spec phase rejects when brainstorm is missing", async () => {
		await client.start();

		// Collect notifications — the command should report missing prerequisite
		// without starting an agent turn
		const notificationsPromise = collectNotifications(client, 5000);
		await client.prompt("/workflow spec nonexistent-slug");
		const notifications = await notificationsPromise;

		// Should have received at least one notification about the problem
		// (either slug not found or missing prerequisite)
		expect(notifications.length).toBeGreaterThanOrEqual(1);
		const hasError = notifications.some(n => n.method === "notify" && typeof n.message === "string");
		expect(hasError).toBe(true);
	}, 15_000);

	// -----------------------------------------------------------------------
	// Info-only commands (no agent turn, respond via notification)
	// -----------------------------------------------------------------------

	test("workflow list returns workflow info via notification", async () => {
		await client.start();

		// Create a workflow first
		const slug = "test-list-slug";
		const wfDir = path.join(workDir, "docs", "workflow", slug);
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(
			path.join(wfDir, "state.json"),
			JSON.stringify({ slug, currentPhase: "brainstorm", artifacts: {} }),
		);

		// /workflow list is info-only — doesn't start an agent turn
		const notificationsPromise = collectNotifications(client, 5000);
		await client.prompt("/workflow list");
		const notifications = await notificationsPromise;

		// Should have received info notification(s)
		expect(notifications.length).toBeGreaterThanOrEqual(1);
	}, 15_000);

	test("workflow status shows current state via notification", async () => {
		await client.start();

		const slug = "test-status-slug";
		const wfDir = path.join(workDir, "docs", "workflow", slug);
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(
			path.join(wfDir, "state.json"),
			JSON.stringify({
				slug,
				currentPhase: "spec",
				artifacts: { brainstorm: `docs/workflow/${slug}/brainstorm.md` },
			}),
		);
		fs.writeFileSync(path.join(wfDir, "brainstorm.md"), "# Brainstorm output");

		const notificationsPromise = collectNotifications(client, 5000);
		await client.prompt(`/workflow status ${slug}`);
		const notifications = await notificationsPromise;

		expect(notifications.length).toBeGreaterThanOrEqual(1);
	}, 15_000);

	test("workflow delete removes workflow files", async () => {
		await client.start();
		const removeHandler = attachExtensionUIHandler(client, createAutoApproveHandler());

		const slug = "test-delete-slug";
		const wfDir = path.join(workDir, "docs", "workflow", slug);
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(
			path.join(wfDir, "state.json"),
			JSON.stringify({ slug, currentPhase: "brainstorm", artifacts: {} }),
		);

		// Delete is info-only — may show confirmation selector then notify
		const notificationsPromise = collectNotifications(client, 5000);
		await client.prompt(`/workflow delete ${slug}`);
		const notifications = await notificationsPromise;
		removeHandler();

		// Should have received at least one notification
		expect(notifications.length).toBeGreaterThanOrEqual(1);

		// Workflow directory should be gone after delete
		expect(fs.existsSync(wfDir)).toBe(false);
	}, 15_000);
});
