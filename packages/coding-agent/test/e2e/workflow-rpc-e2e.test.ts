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

// ---------------------------------------------------------------------------
// Workflow seeding helper
// ---------------------------------------------------------------------------

function seedWorkflow(workDir: string, slug: string, completedPhases: string[]): void {
	const wfDir = path.join(workDir, "docs", "workflow", slug);
	fs.mkdirSync(wfDir, { recursive: true });
	const artifacts: Record<string, string> = {};
	for (const phase of completedPhases) {
		const artifactPath = `docs/workflow/${slug}/${phase}.md`;
		artifacts[phase] = artifactPath;
		fs.writeFileSync(
			path.join(wfDir, `${phase}.md`),
			`# ${phase}\nTest artifact for ${phase} phase.\nThis is a simple calculator app.`,
		);
	}
	fs.writeFileSync(
		path.join(wfDir, "state.json"),
		JSON.stringify({
			slug,
			currentPhase: completedPhases[completedPhases.length - 1] ?? "brainstorm",
			artifacts,
		}),
	);
	fs.writeFileSync(path.join(workDir, "docs", "workflow", ".active"), slug);
}

/**
 * After an agent turn completes, check if the approval dialog appeared.
 * If not (MiniMax M2.7 sometimes doesn't call exit_plan_mode), send a follow-up
 * nudge telling the agent to call the tool, and wait for the next turn.
 */
async function nudgeIfNoApproval(
	client: RpcClient,
	uiRequests: RpcExtensionUIRequest[],
	phase: string,
	slug: string,
	maxAttempts = 3,
	timeoutMs = 120_000,
): Promise<void> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const hasApproval = uiRequests.some(
			r => r.method === "select" && (r.options as string[] | undefined)?.includes("Approve"),
		);
		if (hasApproval) break;
		if (attempt === maxAttempts - 1) break; // Don't nudge on last check
		const eventsPromise = collectUntilIdle(client, timeoutMs);
		client.prompt(
			`You MUST now call the exit_plan_mode tool to complete the ${phase} phase. ` +
				`Write your output to local://${phase.toUpperCase()}.md first, then call exit_plan_mode ` +
				`with title: ${phase.toUpperCase()}, workflowSlug: ${slug}, workflowPhase: ${phase}.`,
		);
		await eventsPromise;
		await Bun.sleep(5000); // Wait for async approval gate + artifact write
	}
}

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
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});

		// Start brainstorm
		const eventsPromise = collectUntilIdle(client, 240_000);
		client.prompt("/workflow brainstorm simple calculator app");
		const events = await eventsPromise;
		await Bun.sleep(5000); // Wait for async approval gate + artifact write
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		// Detect slug from filesystem
		const workflowDir = path.join(workDir, "docs", "workflow");
		expect(fs.existsSync(workflowDir)).toBe(true);
		const slugDirs = fs.readdirSync(workflowDir).filter(f => {
			try {
				return fs.statSync(path.join(workflowDir, f)).isDirectory();
			} catch {
				return false;
			}
		});
		expect(slugDirs.length).toBe(1);
		const slug = slugDirs[0]!;
		expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-/);

		// Nudge if model didn't call exit_plan_mode
		await nudgeIfNoApproval(client, uiRequests, "brainstorm", slug);

		// Slug confirmation dialog was shown with recommended name
		const slugInput = uiRequests.find(r => r.method === "input");
		expect(slugInput).toBeDefined();
		const placeholder = (slugInput as { placeholder?: string }).placeholder;
		expect(placeholder).toBeDefined();
		expect(placeholder!).toMatch(/^\d{4}-\d{2}-\d{2}-simple-calculator/);

		// Artifact persisted after approval
		const stateFile = path.join(workflowDir, slug, "state.json");
		const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
		expect(state.slug).toBe(slug);
		expect(state.artifacts?.brainstorm).toBeDefined();
		expect(fs.existsSync(path.join(workflowDir, slug, "brainstorm.md"))).toBe(true);

		// Approval + continue dialogs shown
		expect(
			uiRequests.some(r => r.method === "select" && (r.options as string[] | undefined)?.includes("Approve")),
		).toBe(true);
		expect(
			uiRequests.some(r => r.method === "select" && (r.options as string[] | undefined)?.includes("Continue")),
		).toBe(true);
		removeHandler();
	}, 480_000);

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
		const hasToolUse = events.some(e => e.type === "tool_execution_start" || e.type === "message_start");
		expect(hasToolUse).toBe(true);
	}, 600_000);

	// -----------------------------------------------------------------------
	// Phase execution: spec (full — artifact + approval assertions)
	// -----------------------------------------------------------------------

	test("spec phase creates artifact and shows approval dialog", async () => {
		await client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});
		const slug = "test-spec-full-slug";
		seedWorkflow(workDir, slug, ["brainstorm"]);

		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow spec ${slug}`);
		const events = await eventsPromise;
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		await nudgeIfNoApproval(client, uiRequests, "spec", slug);

		const wfDir = path.join(workDir, "docs", "workflow", slug);
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, "state.json"), "utf-8"));
		expect(state.artifacts?.spec).toBeDefined();
		expect(fs.existsSync(path.join(wfDir, "spec.md"))).toBe(true);
		expect(uiRequests.some(r => r.method === "select" && (r.options as string[])?.includes("Approve"))).toBe(true);
		expect(uiRequests.some(r => r.method === "select" && (r.options as string[])?.includes("Continue"))).toBe(true);
		removeHandler();
	}, 900_000);

	// -----------------------------------------------------------------------
	// Phase execution: design
	// -----------------------------------------------------------------------

	test("design phase creates artifact and shows approval dialog", async () => {
		await client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});
		const slug = "test-design-slug";
		seedWorkflow(workDir, slug, ["brainstorm", "spec"]);

		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow design ${slug}`);
		const events = await eventsPromise;
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		await nudgeIfNoApproval(client, uiRequests, "design", slug);

		const wfDir = path.join(workDir, "docs", "workflow", slug);
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, "state.json"), "utf-8"));
		expect(state.artifacts?.design).toBeDefined();
		expect(fs.existsSync(path.join(wfDir, "design.md"))).toBe(true);
		expect(uiRequests.some(r => r.method === "select" && (r.options as string[])?.includes("Approve"))).toBe(true);
		expect(uiRequests.some(r => r.method === "select" && (r.options as string[])?.includes("Continue"))).toBe(true);
		removeHandler();
	}, 900_000);

	// -----------------------------------------------------------------------
	// Phase execution: plan
	// -----------------------------------------------------------------------

	test("plan phase creates artifact and shows approval dialog", async () => {
		await client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});
		const slug = "test-plan-slug";
		seedWorkflow(workDir, slug, ["brainstorm", "spec", "design"]);

		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow plan ${slug}`);
		const events = await eventsPromise;
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		await nudgeIfNoApproval(client, uiRequests, "plan", slug);

		const wfDir = path.join(workDir, "docs", "workflow", slug);
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, "state.json"), "utf-8"));
		expect(state.artifacts?.plan).toBeDefined();
		expect(fs.existsSync(path.join(wfDir, "plan.md"))).toBe(true);
		expect(uiRequests.some(r => r.method === "select" && (r.options as string[])?.includes("Approve"))).toBe(true);
		expect(uiRequests.some(r => r.method === "select" && (r.options as string[])?.includes("Continue"))).toBe(true);
		removeHandler();
	}, 900_000);

	// -----------------------------------------------------------------------
	// Phase execution: execute (full tool access, file modifications expected)
	// -----------------------------------------------------------------------

	test("execute phase runs with full tool access and creates artifact", async () => {
		await client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});
		const slug = "test-execute-slug";
		seedWorkflow(workDir, slug, ["brainstorm", "spec", "design", "plan"]);

		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow execute ${slug}`);
		const events = await eventsPromise;
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		await nudgeIfNoApproval(client, uiRequests, "execute", slug);

		const wfDir = path.join(workDir, "docs", "workflow", slug);
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, "state.json"), "utf-8"));
		expect(state.artifacts?.execute).toBeDefined();
		expect(fs.existsSync(path.join(wfDir, "execute.md"))).toBe(true);
		removeHandler();
	}, 900_000);

	// -----------------------------------------------------------------------
	// Phase execution: verify
	// -----------------------------------------------------------------------

	test("verify phase creates artifact", async () => {
		await client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});
		const slug = "test-verify-slug";
		seedWorkflow(workDir, slug, ["brainstorm", "spec", "design", "plan", "execute"]);

		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow verify ${slug}`);
		const events = await eventsPromise;
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		await nudgeIfNoApproval(client, uiRequests, "verify", slug);

		const wfDir = path.join(workDir, "docs", "workflow", slug);
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, "state.json"), "utf-8"));
		expect(state.artifacts?.verify).toBeDefined();
		expect(fs.existsSync(path.join(wfDir, "verify.md"))).toBe(true);
		removeHandler();
	}, 900_000);

	// -----------------------------------------------------------------------
	// Phase execution: finish
	// -----------------------------------------------------------------------

	test("finish phase creates artifact and completes workflow", async () => {
		await client.start();
		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});
		const slug = "test-finish-slug";
		seedWorkflow(workDir, slug, ["brainstorm", "spec", "design", "plan", "execute", "verify"]);

		const eventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow finish ${slug}`);
		const events = await eventsPromise;
		expect(events.some(e => e.type === "agent_start")).toBe(true);

		await nudgeIfNoApproval(client, uiRequests, "finish", slug);

		const wfDir = path.join(workDir, "docs", "workflow", slug);
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, "state.json"), "utf-8"));
		expect(state.artifacts?.finish).toBeDefined();
		expect(fs.existsSync(path.join(wfDir, "finish.md"))).toBe(true);
		removeHandler();
	}, 900_000);

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
		const errorNotify = notifications.find(n => n.method === "notify");
		expect(errorNotify).toBeDefined();
		const errorMessage = (errorNotify as { message: string }).message;
		// Should mention the slug or missing prerequisite
		expect(typeof errorMessage).toBe("string");
		expect(errorMessage.length).toBeGreaterThan(0);
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
		const listSelect = notifications.find(n => n.method === "select");
		expect(listSelect).toBeDefined();
		const listOptions = (listSelect as { options: string[] }).options;
		expect(listOptions.some(o => o.includes("test-list-slug"))).toBe(true);
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

		const statusNotify = notifications.find(n => n.method === "notify");
		expect(statusNotify).toBeDefined();
		expect((statusNotify as { message: string }).message).toContain("test-status-slug");
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
		const deleteNotify = notifications.find(n => n.method === "notify");
		expect(deleteNotify).toBeDefined();
		expect((deleteNotify as { message: string }).message).toContain("test-delete-slug");

		// Workflow directory should be gone after delete
		expect(fs.existsSync(wfDir)).toBe(false);
	}, 15_000);

	// -----------------------------------------------------------------------
	// Multi-phase flow tests
	// -----------------------------------------------------------------------

	test("brainstorm → spec multi-phase flow", async () => {
		await client.start();

		const uiRequests: RpcExtensionUIRequest[] = [];
		const removeHandler = attachExtensionUIHandler(client, request => {
			uiRequests.push(request);
			return createAutoApproveHandler()(request);
		});

		// Phase 1: brainstorm — uses startWorkflow hook
		const brainstormEventsPromise = collectUntilIdle(client, 300_000);
		client.prompt("/workflow brainstorm simple calculator app");
		const brainstormEvents = await brainstormEventsPromise;

		expect(brainstormEvents.some(e => e.type === "agent_start")).toBe(true);
		expect(brainstormEvents.some(e => e.type === "agent_end")).toBe(true);

		// Detect slug created by brainstorm
		const wfDir = path.join(workDir, "docs", "workflow");
		const slugDirs = fs.readdirSync(wfDir).filter(f => {
			try {
				return fs.statSync(path.join(wfDir, f)).isDirectory();
			} catch {
				return false;
			}
		});
		expect(slugDirs.length).toBe(1);
		const slug = slugDirs[0]!;

		// Phase 2: spec — auto-approve handler already attached, send command manually
		const specEventsPromise = collectUntilIdle(client, 600_000);
		client.prompt(`/workflow spec ${slug}`);
		const specEvents = await specEventsPromise;

		removeHandler();

		expect(specEvents.some(e => e.type === "agent_start")).toBe(true);
		expect(specEvents.some(e => e.type === "agent_end")).toBe(true);

		// Both artifacts must exist on disk
		expect(fs.existsSync(path.join(wfDir, slug, "brainstorm.md"))).toBe(true);
		expect(fs.existsSync(path.join(wfDir, slug, "spec.md"))).toBe(true);

		// state.json must record both artifacts
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, slug, "state.json"), "utf-8"));
		expect(state.artifacts?.brainstorm).toBeDefined();
		expect(state.artifacts?.spec).toBeDefined();

		// Approval selector must have fired for both pre-implementation phases
		const approvalSelects = uiRequests.filter(
			r => r.method === "select" && (r.options as string[] | undefined)?.includes("Approve"),
		);
		expect(approvalSelects.length).toBeGreaterThanOrEqual(2);
	}, 900_000);

	test("full 7-phase pipeline", async () => {
		await client.start();

		const removeHandler = attachExtensionUIHandler(client, createAutoApproveHandler());

		const phases = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"] as const;

		// Phase 1: brainstorm — uses startWorkflow hook
		const brainstormEventsPromise = collectUntilIdle(client, 300_000);
		client.prompt("/workflow brainstorm simple calculator app");
		const brainstormEvents = await brainstormEventsPromise;

		expect(brainstormEvents.some(e => e.type === "agent_start")).toBe(true);
		expect(brainstormEvents.some(e => e.type === "agent_end")).toBe(true);

		// Detect slug created by brainstorm
		const wfDir = path.join(workDir, "docs", "workflow");
		const slugDirs = fs.readdirSync(wfDir).filter(f => {
			try {
				return fs.statSync(path.join(wfDir, f)).isDirectory();
			} catch {
				return false;
			}
		});
		expect(slugDirs.length).toBe(1);
		const slug = slugDirs[0]!;

		// Phases 2–7: send each command after the prior one's agent turn completes
		for (const phase of phases.slice(1)) {
			const phaseEventsPromise = collectUntilIdle(client, 600_000);
			client.prompt(`/workflow ${phase} ${slug}`);
			const phaseEvents = await phaseEventsPromise;
			expect(phaseEvents.some(e => e.type === "agent_start")).toBe(true);
			expect(phaseEvents.some(e => e.type === "agent_end")).toBe(true);
		}

		removeHandler();

		// All 7 artifact files must exist
		for (const phase of phases) {
			expect(fs.existsSync(path.join(wfDir, slug, `${phase}.md`))).toBe(true);
		}

		// state.json must record all artifacts and reflect the final phase
		const state = JSON.parse(fs.readFileSync(path.join(wfDir, slug, "state.json"), "utf-8"));
		expect(state.currentPhase).toBe("finish");
		for (const phase of phases) {
			expect(state.artifacts?.[phase]).toBeDefined();
		}
	}, 3_600_000);
});
