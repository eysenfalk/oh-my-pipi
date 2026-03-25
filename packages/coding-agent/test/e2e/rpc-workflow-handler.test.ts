/**
 * Unit tests for RpcWorkflowHandler.
 *
 * Tests exercise every branch via mock session and UI context objects.
 * All tests that touch the approval/plan-file flow write real files to
 * the omp-local session dir and clean up after each test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createWorkflowState,
	getActiveWorkflowSlug,
	readWorkflowArtifact,
	readWorkflowState,
	WORKFLOW_DIR,
	type WorkflowPhase,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RpcWorkflowHandler } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-workflow-handler";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockUIContext {
	#selectQueue: (string | undefined)[] = [];
	#inputQueue: (string | undefined)[] = [];
	#confirmQueue: boolean[] = [];
	notifications: { message: string; type?: string }[] = [];
	selectCalls: { title: string; options: string[] }[] = [];
	inputCalls: { title: string; placeholder?: string }[] = [];

	queueSelect(value: string | undefined): void {
		this.#selectQueue.push(value);
	}
	queueInput(value: string | undefined): void {
		this.#inputQueue.push(value);
	}
	queueConfirm(value: boolean): void {
		this.#confirmQueue.push(value);
	}

	select(title: string, options: string[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		if (this.#selectQueue.length === 0) {
			throw new Error(`Unexpected select call: "${title}". Queue is empty. Options: ${JSON.stringify(options)}`);
		}
		return Promise.resolve(this.#selectQueue.shift());
	}

	input(title: string, placeholder?: string): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder });
		if (this.#inputQueue.length === 0) {
			throw new Error(`Unexpected input call: "${title}". Queue is empty.`);
		}
		return Promise.resolve(this.#inputQueue.shift());
	}

	confirm(title: string): Promise<boolean> {
		if (this.#confirmQueue.length === 0) {
			throw new Error(`Unexpected confirm call: "${title}". Queue is empty.`);
		}
		return Promise.resolve(this.#confirmQueue.shift()!);
	}

	notify(message: string, type?: string): void {
		this.notifications.push({ message, type: type ?? "info" });
	}

	// Unused interface methods — no-ops so the mock satisfies ExtensionUIContext
	setStatus(): void {}
	setWidget(): void {}
	setTitle(): void {}
	setWorkingMessage(): void {}
	setFooter(): void {}
	setHeader(): void {}
	onTerminalInput(): () => void {
		return () => {};
	}
	async custom<T>(): Promise<T> {
		return undefined as T;
	}
}

class MockSession {
	prompts: string[] = [];
	aborted = false;
	newSessionCalled = false;
	subscribers: AgentSessionEventListener[] = [];
	#cwd: string;

	constructor(cwd: string) {
		this.#cwd = cwd;
	}

	sessionManager = {
		getCwd: () => this.#cwd,
		getArtifactsDir: (): string | null => null,
		getSessionId: () => "test-session-123",
	};

	abort(): Promise<void> {
		this.aborted = true;
		return Promise.resolve();
	}

	newSession(_opts: Record<string, unknown>): Promise<void> {
		this.newSessionCalled = true;
		return Promise.resolve();
	}

	prompt(text: string): Promise<void> {
		this.prompts.push(text);
		return Promise.resolve();
	}

	subscribe(cb: AgentSessionEventListener): void {
		this.subscribers.push(cb);
	}

	/** Emit an event and await all async subscribers. */
	async emitEvent(event: AgentSessionEvent): Promise<void> {
		for (const sub of this.subscribers) {
			// Subscribers may return Promise<void>; await via Promise.resolve so
			// non-async subscribers (returning void) are handled transparently.
			await Promise.resolve(sub(event));
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-123";

function localRoot(): string {
	return path.join(os.tmpdir(), "omp-local", SESSION_ID);
}

/** Write a plan file at the local:// path and return the local:// URL. */
async function writePlanFile(phase: string, content: string): Promise<string> {
	const dir = localRoot();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, `${phase.toUpperCase()}.md`), content);
	return `local://${phase.toUpperCase()}.md`;
}

/** Remove the plan files for this session. */
async function cleanPlanFiles(): Promise<void> {
	await fs.rm(localRoot(), { recursive: true, force: true });
}

/**
 * Build a tool_execution_end event for exit_plan_mode.
 * Undefined fields are omitted so the handler's fallback logic is exercisable.
 */
function makeExitPlanEvent(opts: {
	workflowSlug?: string;
	workflowPhase?: string;
	planFilePath?: string;
	planExists?: boolean;
	reviewCompleted?: boolean;
}): AgentSessionEvent {
	const details: Record<string, unknown> = {
		planFilePath: opts.planFilePath ?? "local://BRAINSTORM.md",
		planExists: opts.planExists ?? true,
	};
	if (opts.workflowSlug !== undefined) details.workflowSlug = opts.workflowSlug;
	if (opts.workflowPhase !== undefined) details.workflowPhase = opts.workflowPhase;
	if (opts.reviewCompleted !== undefined) details.reviewCompleted = opts.reviewCompleted;

	return {
		type: "tool_execution_end",
		toolCallId: "call-1",
		toolName: "exit_plan_mode",
		isError: false,
		result: { details },
	} as unknown as AgentSessionEvent;
}

function makeToolEvent(toolName: string, details: Record<string, unknown>, isError = false): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: "call-2",
		toolName,
		isError,
		result: { details },
	} as unknown as AgentSessionEvent;
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let cwd: string;
let session: MockSession;
let ui: MockUIContext;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-handler-"));
	session = new MockSession(cwd);
	ui = new MockUIContext();
	_resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"workflow.phases.brainstorm.approval": "none",
			"workflow.phases.spec.approval": "none",
			"workflow.phases.design.approval": "none",
			"workflow.phases.plan.approval": "none",
			"workflow.phases.execute.approval": "none",
			"workflow.phases.verify.approval": "none",
			"workflow.phases.finish.approval": "none",
		},
	});
});

afterEach(async () => {
	_resetSettingsForTest();
	await cleanPlanFiles();
	await fs.rm(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Factory shorthand — always re-create so each test gets a fresh handler
// ---------------------------------------------------------------------------

function makeHandler(): RpcWorkflowHandler {
	return new RpcWorkflowHandler(session as unknown as AgentSession, ui as unknown as ExtensionUIContext);
}

// ===========================================================================
// startWorkflow
// ===========================================================================

describe("startWorkflow", () => {
	test("creates state, sets active slug, submits brainstorm prompt", async () => {
		const h = makeHandler();
		ui.queueInput("my-workflow");

		await h.startWorkflow({ topic: "my topic", slug: "my-workflow" });

		const state = await readWorkflowState(cwd, "my-workflow");
		expect(state).not.toBeNull();
		expect(state!.slug).toBe("my-workflow");

		const active = await getActiveWorkflowSlug(cwd);
		expect(active).toBe("my-workflow");

		expect(session.aborted).toBe(true);
		expect(session.newSessionCalled).toBe(true);
		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toContain("my topic");
	});

	test("recommended slug is passed as placeholder to input", async () => {
		const h = makeHandler();
		ui.queueInput("provided-slug");

		await h.startWorkflow({ topic: "some topic", slug: "provided-slug" });

		expect(ui.inputCalls).toHaveLength(1);
		expect(ui.inputCalls[0].placeholder).toBe("provided-slug");
	});

	test("input returns whitespace-only string → returns without creating state", async () => {
		const h = makeHandler();
		ui.queueInput("   ");

		await h.startWorkflow({ topic: "test topic", slug: "test-slug" });

		expect(session.prompts).toHaveLength(0);
		expect(session.aborted).toBe(false);
		const state = await readWorkflowState(cwd, "test-slug");
		expect(state).toBeNull();
	});

	test("cancelled input (undefined) → returns without creating state", async () => {
		const h = makeHandler();
		ui.queueInput(undefined);

		await h.startWorkflow({ topic: "test topic", slug: "test-slug" });

		expect(session.prompts).toHaveLength(0);
		const state = await readWorkflowState(cwd, "test-slug");
		expect(state).toBeNull();
	});

	test("collision: existing state → shows Overwrite selector", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "existing-slug");

		ui.queueInput("existing-slug");
		ui.queueSelect("Overwrite");

		await h.startWorkflow({ topic: "test", slug: "existing-slug" });

		expect(ui.selectCalls).toHaveLength(1);
		expect(ui.selectCalls[0].title).toContain("existing-slug");
		expect(ui.selectCalls[0].options).toContain("Overwrite");
		expect(session.prompts).toHaveLength(1);
	});

	test("collision: cancel → returns without overwriting, no prompt submitted", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "existing-slug");

		ui.queueInput("existing-slug");
		ui.queueSelect("Cancel");

		await h.startWorkflow({ topic: "test", slug: "existing-slug" });

		expect(session.prompts).toHaveLength(0);
		expect(session.aborted).toBe(false);
	});

	test("sets activeWorkflow getter after creation", async () => {
		const h = makeHandler();
		ui.queueInput("new-slug");

		await h.startWorkflow({ topic: "test topic", slug: "new-slug" });

		const aw = h.activeWorkflow;
		expect(aw.slug).toBe("new-slug");
		expect(aw.phase).toBe("brainstorm");
		expect(aw.phases).toBeNull();
	});

	test("generateSlug is used when no slug provided", async () => {
		const h = makeHandler();
		// No slug in details — handler calls generateSlug(topic) which adds date prefix
		// Just confirm it asks the user and uses something date-like as placeholder
		ui.queueInput("custom-override");

		await h.startWorkflow({ topic: "auto slug topic" });

		expect(ui.inputCalls).toHaveLength(1);
		// generateSlug produces YYYY-MM-DD-auto-slug-topic; placeholder must be set
		expect(ui.inputCalls[0].placeholder).toMatch(/^\d{4}-\d{2}-\d{2}-auto-slug-topic$/);
	});
});

// ===========================================================================
// switchWorkflow
// ===========================================================================

describe("switchWorkflow", () => {
	test("valid slug + confirm selector → updates active workflow", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "target-slug");

		ui.queueSelect("Yes, switch");

		await h.switchWorkflow({ slug: "target-slug" });

		expect(h.activeWorkflow.slug).toBe("target-slug");
		expect(ui.notifications).toHaveLength(1);
		expect(ui.notifications[0].message).toContain("Switched to workflow: target-slug");
	});

	test("cancel → active workflow unchanged, no notification", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "target-slug");

		ui.queueSelect("Cancel");

		await h.switchWorkflow({ slug: "target-slug" });

		expect(h.activeWorkflow.slug).toBeNull();
		expect(ui.notifications).toHaveLength(0);
	});

	test("non-existent slug → error notification, no state change", async () => {
		const h = makeHandler();

		await h.switchWorkflow({ slug: "nonexistent" });

		expect(ui.notifications).toHaveLength(1);
		expect(ui.notifications[0].type).toBe("error");
		expect(ui.notifications[0].message).toContain("nonexistent");
		expect(h.activeWorkflow.slug).toBeNull();
	});

	test("confirm: true → skips selector, switches directly", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "fast-switch");

		await h.switchWorkflow({ slug: "fast-switch", confirm: true });

		expect(ui.selectCalls).toHaveLength(0);
		expect(h.activeWorkflow.slug).toBe("fast-switch");
	});
});

// ===========================================================================
// activateWorkflowPhase
// ===========================================================================

describe("activateWorkflowPhase", () => {
	test("sets slug, phase, phases in activeWorkflow getter", () => {
		const h = makeHandler();
		const phases: WorkflowPhase[] = ["brainstorm", "spec", "design"];

		h.activateWorkflowPhase("my-slug", "spec", phases);

		const aw = h.activeWorkflow;
		expect(aw.slug).toBe("my-slug");
		expect(aw.phase).toBe("spec");
		expect(aw.phases).toEqual(phases);
	});

	test("writes active slug to disk (.active file)", async () => {
		const h = makeHandler();
		h.activateWorkflowPhase("disk-slug", "plan");

		// setActiveWorkflowSlug is fire-and-forget (void); wait for microtask queue
		await new Promise(resolve => setTimeout(resolve, 20));

		const active = await getActiveWorkflowSlug(cwd);
		expect(active).toBe("disk-slug");
	});

	test("null phases stored as null", () => {
		const h = makeHandler();
		h.activateWorkflowPhase("no-phases-slug", "execute", null);

		expect(h.activeWorkflow.phases).toBeNull();
	});

	test("undefined phases stored as null", () => {
		const h = makeHandler();
		h.activateWorkflowPhase("slug", "verify");

		expect(h.activeWorkflow.phases).toBeNull();
	});
});

// ===========================================================================
// subscribeToEvents — exit_plan_mode routing
// ===========================================================================

describe("subscribeToEvents — exit_plan_mode routing", () => {
	test("workflowSlug + workflowPhase in event → aborts session and runs phase complete", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec content");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.aborted).toBe(true);
		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# Spec content");
	});

	test("no workflowSlug in event → falls back to #activeWorkflowSlug", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "fallback-slug");
		await writePlanFile("spec", "# Fallback spec");

		// Set active slug internally
		h.activateWorkflowPhase("fallback-slug", "spec");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				// No workflowSlug
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "fallback-slug", "spec");
		expect(artifact).toBe("# Fallback spec");
	});

	test("no workflowPhase in event → falls back to #activeWorkflowPhase", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Phase fallback");

		h.activateWorkflowPhase("test-slug", "spec");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				// No workflowPhase
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# Phase fallback");
	});

	test("no active workflow and no event params → silently ignored", async () => {
		const h = makeHandler();
		h.subscribeToEvents();

		await session.emitEvent(
			makeExitPlanEvent({
				// No workflowSlug, no workflowPhase; handler has no active state
			}),
		);

		expect(session.aborted).toBe(false);
		expect(session.prompts).toHaveLength(0);
		expect(ui.notifications).toHaveLength(0);
	});

	test("isError events are skipped entirely", async () => {
		const h = makeHandler();
		h.subscribeToEvents();

		await session.emitEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "exit_plan_mode",
			isError: true,
			result: {
				details: {
					workflowSlug: "slug",
					workflowPhase: "brainstorm",
					planFilePath: "local://BRAINSTORM.md",
					planExists: false,
				},
			},
		} as unknown as AgentSessionEvent);

		expect(session.aborted).toBe(false);
		expect(ui.notifications).toHaveLength(0);
	});

	test("result with no details is skipped", async () => {
		const h = makeHandler();
		h.subscribeToEvents();

		await session.emitEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "exit_plan_mode",
			isError: false,
			result: null,
		} as unknown as AgentSessionEvent);

		expect(session.aborted).toBe(false);
	});
});

// ===========================================================================
// subscribeToEvents — propose_phases
// ===========================================================================

describe("subscribeToEvents — propose_phases", () => {
	test("stores proposed phases and surfaces them at next brainstorm completion", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("brainstorm", "# Brainstorm");

		h.subscribeToEvents();
		h.activateWorkflowPhase("test-slug", "brainstorm");

		// Store the proposed phases
		await session.emitEvent(
			makeToolEvent("propose_phases", {
				phases: ["brainstorm", "spec", "plan"],
				rationale: "Lean flow",
			}),
		);

		// When brainstorm completes, the phase proposal dialog should appear
		ui.queueSelect("Reject (use global settings)"); // dismiss proposal
		ui.queueSelect("Stop here");

		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "brainstorm",
				planFilePath: "local://BRAINSTORM.md",
			}),
		);

		expect(ui.selectCalls[0].title).toContain("brainstorm → spec → plan");
	});
});

// ===========================================================================
// subscribeToEvents — start_workflow routing
// ===========================================================================

describe("subscribeToEvents — start_workflow", () => {
	test("routes to startWorkflow method", async () => {
		const h = makeHandler();
		h.subscribeToEvents();

		ui.queueInput("event-slug");

		await session.emitEvent(makeToolEvent("start_workflow", { topic: "event topic", slug: "event-slug" }));

		const state = await readWorkflowState(cwd, "event-slug");
		expect(state).not.toBeNull();
		expect(state!.slug).toBe("event-slug");
	});
});

// ===========================================================================
// subscribeToEvents — switch_workflow routing
// ===========================================================================

describe("subscribeToEvents — switch_workflow", () => {
	test("routes to switchWorkflow method", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "switch-target");

		h.subscribeToEvents();

		await session.emitEvent(makeToolEvent("switch_workflow", { slug: "switch-target", confirm: true }));

		expect(h.activeWorkflow.slug).toBe("switch-target");
	});
});

// ===========================================================================
// handleWorkflowPhaseComplete — plan file handling
// ===========================================================================

describe("handleWorkflowPhaseComplete — plan file", () => {
	test("plan file found → writes artifact after approval", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# My spec");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# My spec");
	});

	test("plan file NOT found → error notification, no artifact", async () => {
		const h = makeHandler();
		h.subscribeToEvents();
		h.activateWorkflowPhase("test-slug", "spec");

		// Do NOT write plan file

		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(ui.notifications).toHaveLength(1);
		expect(ui.notifications[0].type).toBe("error");
		expect(ui.notifications[0].message).toContain("SPEC.md");
		expect(session.prompts).toHaveLength(0);
	});
});

// ===========================================================================
// handleWorkflowPhaseComplete — brainstorm + proposed phases
// ===========================================================================

describe("handleWorkflowPhaseComplete — brainstorm phase proposal", () => {
	test("Accept proposal → artifact uses proposed phases as activePhases", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("brainstorm", "# Brainstorm");

		h.subscribeToEvents();
		h.activateWorkflowPhase("test-slug", "brainstorm");

		await session.emitEvent(
			makeToolEvent("propose_phases", {
				phases: ["brainstorm", "spec", "plan"],
				rationale: "Lean",
			}),
		);

		ui.queueSelect("Accept");
		ui.queueSelect("Stop here");

		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "brainstorm",
				planFilePath: "local://BRAINSTORM.md",
			}),
		);

		const state = await readWorkflowState(cwd, "test-slug");
		expect(state?.activePhases).toEqual(["brainstorm", "spec", "plan"]);
	});

	test("Edit phases → parses comma/space-separated list, updates activePhases", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("brainstorm", "# Brainstorm");

		h.subscribeToEvents();
		h.activateWorkflowPhase("test-slug", "brainstorm");

		await session.emitEvent(
			makeToolEvent("propose_phases", {
				phases: ["brainstorm", "spec", "plan", "execute"],
				rationale: "",
			}),
		);

		ui.queueSelect("Edit phases");
		ui.queueInput("brainstorm, spec, execute");
		ui.queueSelect("Stop here");

		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "brainstorm",
				planFilePath: "local://BRAINSTORM.md",
			}),
		);

		const state = await readWorkflowState(cwd, "test-slug");
		expect(state?.activePhases).toEqual(["brainstorm", "spec", "execute"]);
	});

	test("Reject proposal → uses global settings (no activePhases set)", async () => {
		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("brainstorm", "# Brainstorm");

		h.subscribeToEvents();
		h.activateWorkflowPhase("test-slug", "brainstorm");

		await session.emitEvent(
			makeToolEvent("propose_phases", {
				phases: ["brainstorm", "spec"],
				rationale: "",
			}),
		);

		ui.queueSelect("Reject (use global settings)");
		ui.queueSelect("Stop here");

		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "brainstorm",
				planFilePath: "local://BRAINSTORM.md",
			}),
		);

		const state = await readWorkflowState(cwd, "test-slug");
		// Reject means no activePhases override
		expect(state?.activePhases).toBeUndefined();
	});
});

// ===========================================================================
// handleWorkflowPhaseComplete — reviewCompleted
// ===========================================================================

describe("handleWorkflowPhaseComplete — reviewCompleted", () => {
	test("reviewCompleted: true → bypasses approval gate, calls runUserApproval directly", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "workflow.phases.spec.approval": "agent" }, // would normally return reviewPrompt
		});

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		// Since reviewCompleted is true, runUserApproval is called → shows user approval dialog
		ui.queueSelect("Approve");
		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
				reviewCompleted: true,
			}),
		);

		// Artifact written (user approved)
		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# Spec");

		// No review prompt was submitted to session (agent review skipped)
		expect(session.prompts).toHaveLength(0);
	});
});

// ===========================================================================
// handleWorkflowPhaseComplete — approval modes
// ===========================================================================

describe("handleWorkflowPhaseComplete — approval modes", () => {
	test("mode none → auto-approves, writes artifact, offers Continue", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "none" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec content");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# Spec content");

		// Continue dialog was shown (next phase after spec is design)
		expect(ui.selectCalls).toHaveLength(1);
		expect(ui.selectCalls[0].title).toContain("spec");
		expect(ui.selectCalls[0].title).toContain("design");
	});

	test("mode user → Approve → artifact written", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "user" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Approve");
		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# Spec");
	});

	test("mode user → Refine → reason submitted as prompt, no artifact", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "user" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Refine");
		ui.queueInput("Please add more detail to section 2");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBeNull();

		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toBe("Please add more detail to section 2");
	});

	test("mode user → Reject → no artifact written", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "user" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		// Reject → second select for retry/abandon → "Retry phase" → reason submitted as prompt
		ui.queueSelect("Reject");
		ui.queueSelect("Retry phase");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBeNull();

		// Retry reason was submitted
		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toContain("retry");
	});
});

// ===========================================================================
// handleWorkflowPhaseComplete — review rounds (agent approval mode)
// ===========================================================================

describe("handleWorkflowPhaseComplete — review rounds", () => {
	test("agent mode → reviewPrompt submitted as session.prompt", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"workflow.phases.spec.approval": "agent",
				"workflow.phases.spec.maxReviewRounds": "3",
			},
		});

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toContain("spec");
	});

	test("second review round increments counter, still submits prompt", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"workflow.phases.spec.approval": "agent",
				"workflow.phases.spec.maxReviewRounds": "3",
			},
		});

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");

		h.subscribeToEvents();

		// Round 1
		await writePlanFile("spec", "# Spec v1");
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(1);

		// Round 2 — still under maxRounds (3)
		await writePlanFile("spec", "# Spec v2");
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(2);

		// No escalation warnings yet
		const warnings = ui.notifications.filter(n => n.type === "warning");
		expect(warnings).toHaveLength(0);
	});

	test("maxRounds reached → escalation notification + user approval fallback", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"workflow.phases.spec.approval": "agent",
				"workflow.phases.spec.maxReviewRounds": "1", // escalate on first round
			},
		});

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		// After escalation runUserApproval is called
		ui.queueSelect("Approve");
		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const warnings = ui.notifications.filter(n => n.type === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain("Maximum 1 review round");

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBe("# Spec");
	});

	test("maxRounds=1 uses singular 'round' (not 'rounds') in notification", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"workflow.phases.spec.approval": "agent",
				"workflow.phases.spec.maxReviewRounds": "1",
			},
		});

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Approve");
		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const warning = ui.notifications.find(n => n.type === "warning");
		expect(warning).not.toBeUndefined();
		expect(warning!.message).toContain("1 review round");
		expect(warning!.message).not.toContain("rounds");
	});

	test("maxRounds=2 uses plural 'rounds' in notification", async () => {
		_resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"workflow.phases.spec.approval": "agent",
				"workflow.phases.spec.maxReviewRounds": "2",
			},
		});

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");

		h.subscribeToEvents();

		// Round 1 (prompt submitted, no escalation)
		await writePlanFile("spec", "# Spec v1");
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		// Round 2 = maxRounds → escalate
		ui.queueSelect("Approve");
		ui.queueSelect("Stop here");

		await writePlanFile("spec", "# Spec v2");
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const warning = ui.notifications.find(n => n.type === "warning");
		expect(warning).not.toBeUndefined();
		expect(warning!.message).toContain("2 review rounds");
	});
});

// ===========================================================================
// handleApprovalResult
// ===========================================================================

describe("handleApprovalResult", () => {
	test("approved → Continue → submits /workflow <nextPhase> <slug>", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "none" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Continue");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toBe("/workflow design test-slug");
	});

	test("approved → Stop here → no further prompts submitted", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "none" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(0);
	});

	test("not approved with reason → reason submitted as session.prompt", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "user" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Refine");
		ui.queueInput("Needs more detail in section 3");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(1);
		expect(session.prompts[0]).toBe("Needs more detail in section 3");
	});

	test("not approved with no reason → silent return, no prompt, no artifact", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "user" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		// Escape/cancel from selector → undefined → { approved: false } with no reason
		ui.queueSelect(undefined);

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		expect(session.prompts).toHaveLength(0);
		const artifact = await readWorkflowArtifact(cwd, "test-slug", "spec");
		expect(artifact).toBeNull();

		const errors = ui.notifications.filter(n => n.type === "error");
		expect(errors).toHaveLength(0);
	});

	test("writeWorkflowArtifact fails → error notification, no Continue offered", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "none" } });

		const h = makeHandler();
		await writePlanFile("spec", "# Spec");

		// Create a regular file where the workflow slug directory should be,
		// so mkdir inside writeWorkflowArtifact fails with ENOTDIR.
		const workflowRoot = path.join(cwd, WORKFLOW_DIR);
		await fs.mkdir(workflowRoot, { recursive: true });
		await fs.writeFile(path.join(workflowRoot, "test-slug"), "not-a-directory");

		h.subscribeToEvents();
		h.activateWorkflowPhase("test-slug", "spec");

		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		const errors = ui.notifications.filter(n => n.type === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("Failed to persist spec artifact");

		// No Continue offered → no prompts
		expect(session.prompts).toHaveLength(0);
	});

	test("last phase (finish) → no Continue selector shown after approval", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.finish.approval": "none" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("finish", "# Final report");

		// No select queued — if the handler tries to show Continue it will throw
		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "finish",
				planFilePath: "local://FINISH.md",
			}),
		);

		expect(ui.selectCalls).toHaveLength(0);
		expect(session.prompts).toHaveLength(0);

		const artifact = await readWorkflowArtifact(cwd, "test-slug", "finish");
		expect(artifact).toBe("# Final report");
	});
});

// ===========================================================================
// activeWorkflow getter
// ===========================================================================

describe("activeWorkflow getter", () => {
	test("initial state has null slug, phase, and phases", () => {
		const h = makeHandler();
		const aw = h.activeWorkflow;
		expect(aw.slug).toBeNull();
		expect(aw.phase).toBeNull();
		expect(aw.phases).toBeNull();
	});

	test("updates slug and phase after successful event handling", async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "workflow.phases.spec.approval": "none" } });

		const h = makeHandler();
		await createWorkflowState(cwd, "test-slug");
		await writePlanFile("spec", "# Spec");

		ui.queueSelect("Stop here");

		h.subscribeToEvents();
		await session.emitEvent(
			makeExitPlanEvent({
				workflowSlug: "test-slug",
				workflowPhase: "spec",
				planFilePath: "local://SPEC.md",
			}),
		);

		// After writing spec artifact, next phase is design
		const aw = h.activeWorkflow;
		expect(aw.slug).toBe("test-slug");
		expect(aw.phase).toBe("design"); // updated to nextPhase
	});
});
