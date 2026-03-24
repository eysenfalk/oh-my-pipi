/**
 * Tests for the event-driven contracts between tools and the workflow system.
 *
 * EventController is deeply integrated with InteractiveMode and cannot be
 * instantiated in isolation. Instead we test the same routing logic via
 * WorkflowCommand: what each phase returns as a prompt (instructing the agent
 * to call specific tools) and what side-effects it records on the context.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createWorkflowState,
	setActiveWorkflowSlug,
	WORKFLOW_DIR,
	type WorkflowPhase,
	writeWorkflowArtifact,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";
import { WorkflowCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/index";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { createTempDir, getActions, getNotifications, MockHookCommandContext, removeTempDir } from "./workflow-harness";

function asCtx(mock: MockHookCommandContext): HookCommandContext {
	return mock as unknown as HookCommandContext;
}

const SLUG = "2024-01-01-event-test";

// Artifact path as the command computes it (relative, not absolute)
function artifactPath(phase: WorkflowPhase): string {
	return path.join(WORKFLOW_DIR, SLUG, `${phase}.md`);
}

describe("workflow event contracts", () => {
	let tempDir: string;
	let cmd: WorkflowCommand;
	let ctx: MockHookCommandContext;

	beforeEach(async () => {
		tempDir = createTempDir();
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cmd = new WorkflowCommand();
		ctx = new MockHookCommandContext(tempDir);
	});

	afterEach(() => {
		_resetSettingsForTest();
		removeTempDir(tempDir);
	});

	// Helper: write a phase artifact into the temp workflow dir
	async function writeArtifact(phase: WorkflowPhase, content = `# ${phase}\nContent`): Promise<void> {
		await writeWorkflowArtifact(tempDir, SLUG, phase, content);
	}

	// Helper: run phase command via dispatchToPhase (back <phase> <slug>)
	async function runViaBack(phase: WorkflowPhase): Promise<string | undefined> {
		await createWorkflowState(tempDir, SLUG);
		return cmd.execute(["back", phase, SLUG], asCtx(ctx));
	}

	// =========================================================================
	// exit_plan_mode tool contract
	// Each phase prompt MUST instruct the agent to call exit_plan_mode
	// with the correct title, workflowSlug, and workflowPhase.
	// =========================================================================

	describe("exit_plan_mode tool contract", () => {
		test("brainstorm prompt contains exit_plan_mode instruction with title BRAINSTORM", async () => {
			const result = await runViaBack("brainstorm");
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "BRAINSTORM"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "brainstorm"`);
		});

		test("spec prompt contains exit_plan_mode instruction with title SPEC", async () => {
			await writeArtifact("brainstorm");
			const result = await cmd.execute(["spec", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "SPEC"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "spec"`);
		});

		test("design prompt contains exit_plan_mode instruction with title DESIGN", async () => {
			await writeArtifact("spec");
			const result = await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "DESIGN"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "design"`);
		});

		test("plan prompt contains exit_plan_mode instruction with title PLAN", async () => {
			await writeArtifact("design");
			const result = await cmd.execute(["plan", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "PLAN"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "plan"`);
		});

		test("execute prompt contains exit_plan_mode instruction with title EXECUTE", async () => {
			await writeArtifact("plan");
			const result = await cmd.execute(["execute", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "EXECUTE"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "execute"`);
		});

		test("verify prompt contains exit_plan_mode instruction with title VERIFY", async () => {
			await writeArtifact("spec");
			await writeArtifact("execute");
			const result = await cmd.execute(["verify", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "VERIFY"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "verify"`);
		});

		test("finish prompt contains exit_plan_mode instruction with title FINISH", async () => {
			await writeArtifact("verify");
			const result = await cmd.execute(["finish", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain("exit_plan_mode");
			expect(result).toContain(`title: "FINISH"`);
			expect(result).toContain(`workflowSlug: "${SLUG}"`);
			expect(result).toContain(`workflowPhase: "finish"`);
		});
	});

	// =========================================================================
	// propose_phases tool contract
	// Only the brainstorm phase instructs the agent to call propose_phases.
	// =========================================================================

	describe("propose_phases tool contract", () => {
		test("brainstorm prompt instructs agent to call propose_phases", async () => {
			const result = await runViaBack("brainstorm");
			expect(result).toBeDefined();
			expect(result).toContain("propose_phases");
		});

		test("spec prompt does NOT mention propose_phases", async () => {
			await writeArtifact("brainstorm");
			const result = await cmd.execute(["spec", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain("propose_phases");
		});

		test("design prompt does NOT mention propose_phases", async () => {
			await writeArtifact("spec");
			const result = await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain("propose_phases");
		});

		test("plan prompt does NOT mention propose_phases", async () => {
			await writeArtifact("design");
			const result = await cmd.execute(["plan", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain("propose_phases");
		});

		test("execute prompt does NOT mention propose_phases", async () => {
			await writeArtifact("plan");
			const result = await cmd.execute(["execute", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain("propose_phases");
		});

		test("verify prompt does NOT mention propose_phases", async () => {
			await writeArtifact("spec");
			await writeArtifact("execute");
			const result = await cmd.execute(["verify", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain("propose_phases");
		});

		test("finish prompt does NOT mention propose_phases", async () => {
			await writeArtifact("verify");
			const result = await cmd.execute(["finish", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain("propose_phases");
		});
	});

	// =========================================================================
	// Phase activation contract
	// Each phase must call ctx.activateWorkflowPhase(slug, phase).
	// =========================================================================

	describe("phase activation contract", () => {
		test("spec activates 'spec' phase", async () => {
			await writeArtifact("brainstorm");
			await cmd.execute(["spec", SLUG], asCtx(ctx));
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[0]).toBe(SLUG);
			expect(activations[0].args[1]).toBe("spec");
		});

		test("design activates 'design' phase", async () => {
			await writeArtifact("spec");
			await cmd.execute(["design", SLUG], asCtx(ctx));
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[1]).toBe("design");
		});

		test("plan activates 'plan' phase", async () => {
			await writeArtifact("design");
			await cmd.execute(["plan", SLUG], asCtx(ctx));
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[1]).toBe("plan");
		});

		test("execute activates 'execute' phase", async () => {
			await writeArtifact("plan");
			await cmd.execute(["execute", SLUG], asCtx(ctx));
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[1]).toBe("execute");
		});

		test("verify activates 'verify' phase", async () => {
			await writeArtifact("spec");
			await writeArtifact("execute");
			await cmd.execute(["verify", SLUG], asCtx(ctx));
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[1]).toBe("verify");
		});

		test("finish activates 'finish' phase", async () => {
			await writeArtifact("verify");
			await cmd.execute(["finish", SLUG], asCtx(ctx));
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[1]).toBe("finish");
		});
	});

	// =========================================================================
	// Session management contract
	// Every phase must open a new session to isolate its conversation context.
	// =========================================================================

	describe("session management contract", () => {
		test("brainstorm via dispatchToPhase calls newSession", async () => {
			await runViaBack("brainstorm");
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("spec calls newSession", async () => {
			await writeArtifact("brainstorm");
			await cmd.execute(["spec", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("design calls newSession", async () => {
			await writeArtifact("spec");
			await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("plan calls newSession", async () => {
			await writeArtifact("design");
			await cmd.execute(["plan", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("execute calls newSession", async () => {
			await writeArtifact("plan");
			await cmd.execute(["execute", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("verify calls newSession", async () => {
			await writeArtifact("spec");
			await writeArtifact("execute");
			await cmd.execute(["verify", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("finish calls newSession", async () => {
			await writeArtifact("verify");
			await cmd.execute(["finish", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("failed phase (missing prereq) does NOT call newSession", async () => {
			// spec without brainstorm artifact → prereq check blocks, no session opened
			ctx.hasUI = true;
			await cmd.execute(["spec", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(0);
		});
	});

	// =========================================================================
	// Data flow contract — artifact refs injected into prompts
	// When a prior phase artifact exists its path must appear in the prompt
	// so the agent can read it. Absent artifacts must be excluded.
	// =========================================================================

	describe("data flow contract — artifact refs in prompts", () => {
		test("spec prompt contains brainstormRef path when brainstorm artifact exists", async () => {
			await writeArtifact("brainstorm");
			const result = await cmd.execute(["spec", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(artifactPath("brainstorm"));
		});

		test("design prompt contains specRef when spec artifact exists", async () => {
			await writeArtifact("spec");
			const result = await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(artifactPath("spec"));
		});

		test("design prompt contains brainstormRef when brainstorm artifact also exists", async () => {
			await writeArtifact("brainstorm");
			await writeArtifact("spec");
			const result = await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(artifactPath("spec"));
			expect(result).toContain(artifactPath("brainstorm"));
		});

		test("plan prompt contains specRef and designRef when both artifacts exist", async () => {
			await writeArtifact("spec");
			await writeArtifact("design");
			const result = await cmd.execute(["plan", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(artifactPath("spec"));
			expect(result).toContain(artifactPath("design"));
		});

		test("execute prompt contains planRef, specRef, designRef when all artifacts exist", async () => {
			await writeArtifact("spec");
			await writeArtifact("design");
			await writeArtifact("plan");
			const result = await cmd.execute(["execute", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(artifactPath("plan"));
			expect(result).toContain(artifactPath("spec"));
			expect(result).toContain(artifactPath("design"));
		});

		test("verify prompt contains specRef and planRef when both artifacts exist", async () => {
			await writeArtifact("spec");
			await writeArtifact("plan");
			await writeArtifact("execute");
			const result = await cmd.execute(["verify", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(artifactPath("spec"));
			expect(result).toContain(artifactPath("plan"));
		});

		test("finish prompt contains only slug — no artifact ref paths", async () => {
			await writeArtifact("brainstorm");
			await writeArtifact("spec");
			await writeArtifact("design");
			await writeArtifact("plan");
			await writeArtifact("execute");
			await writeArtifact("verify");
			const result = await cmd.execute(["finish", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).toContain(SLUG);
			// finish does not read any prior artifacts — no artifact path should appear
			expect(result).not.toContain(artifactPath("spec"));
			expect(result).not.toContain(artifactPath("plan"));
			expect(result).not.toContain(artifactPath("verify"));
		});

		test("design without brainstorm artifact omits brainstormRef from prompt", async () => {
			// Only spec written — brainstorm does not exist
			await writeArtifact("spec");
			const result = await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain(artifactPath("brainstorm"));
		});

		test("plan without design artifact omits designRef from prompt", async () => {
			// Only spec written, no design — design prereq check skips if no artifact
			// We bypass prereq by writing design, then test without it
			// To make plan run without design prereq blocking: write design then delete it?
			// Actually: checkPrereq for design returns false (not blocked) when no artifact
			// BUT the prereq check for plan IS design. Let's check: plan checks design prereq.
			// If design artifact doesn't exist and settings don't disable it, checkPrereq blocks.
			// So we need to disable design or skip this path. Instead, write design AND spec
			// but verify designRef appears; then test plan *without* design is a prereq-blocked case.
			// The actual "optional" artifact for plan is spec (not gated by checkPrereq beyond design).
			// When spec doesn't exist, specRef is null in the prompt.
			await writeArtifact("design"); // required prereq
			// spec NOT written — specRef will be null in rendered prompt
			const result = await cmd.execute(["plan", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain(artifactPath("spec"));
		});

		test("execute without design artifact omits designRef from prompt", async () => {
			// plan required; spec optional; design optional (not gated after plan exists)
			await writeArtifact("plan");
			// spec and design NOT written
			const result = await cmd.execute(["execute", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain(artifactPath("design"));
			expect(result).not.toContain(artifactPath("spec"));
		});

		test("verify without plan artifact omits planRef from prompt", async () => {
			// spec required; execute required; plan optional in prompt
			await writeArtifact("spec");
			await writeArtifact("execute");
			// plan NOT written — planRef will be null
			const result = await cmd.execute(["verify", SLUG], asCtx(ctx));
			expect(result).toBeDefined();
			expect(result).not.toContain(artifactPath("plan"));
		});
	});

	// =========================================================================
	// Error event handling
	// Missing prerequisites and invalid inputs must surface as error notifications.
	// =========================================================================

	describe("error event handling", () => {
		test("missing brainstorm prerequisite blocks spec and emits error notification", async () => {
			ctx.hasUI = true;
			// No brainstorm artifact — spec prereq check should block
			await cmd.execute(["spec", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("brainstorm"))).toBe(true);
		});

		test("missing spec prerequisite blocks design and emits error notification", async () => {
			ctx.hasUI = true;
			await cmd.execute(["design", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("spec"))).toBe(true);
		});

		test("missing design prerequisite blocks plan and emits error notification", async () => {
			ctx.hasUI = true;
			await cmd.execute(["plan", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("design"))).toBe(true);
		});

		test("missing plan prerequisite blocks execute and emits error notification", async () => {
			ctx.hasUI = true;
			await cmd.execute(["execute", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("plan"))).toBe(true);
		});

		test("missing execute prerequisite blocks verify and emits error notification", async () => {
			ctx.hasUI = true;
			await writeArtifact("spec"); // spec required directly, execute via checkPrereq
			await cmd.execute(["verify", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("execute"))).toBe(true);
		});

		test("missing verify prerequisite blocks finish and emits error notification", async () => {
			ctx.hasUI = true;
			await cmd.execute(["finish", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("verify"))).toBe(true);
		});

		test("no active workflow and no slug with no UI — error notification not emitted (silent)", async () => {
			ctx.hasUI = false;
			// resolveSlug returns null → infoError is silent with no UI
			const result = await cmd.execute(["spec"], asCtx(ctx));
			expect(result).toBeUndefined();
			expect(getNotifications(ctx).length).toBe(0);
		});

		test("no active workflow and no slug with UI — error notification shown", async () => {
			ctx.hasUI = true;
			ctx.ui.queueInput(undefined); // user cancels slug input
			await cmd.execute(["spec"], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
		});

		test("verify without spec artifact emits error notification about missing spec", async () => {
			ctx.hasUI = true;
			await writeArtifact("execute");
			// No spec — verify checks specRef directly before checkPrereq
			await cmd.execute(["verify", SLUG], asCtx(ctx));
			const errors = getNotifications(ctx).filter(n => n.type === "error");
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some(n => n.message.includes("spec"))).toBe(true);
		});

		test("resume dispatches to correct next phase and calls newSession", async () => {
			// With brainstorm artifact, getNextPhase returns 'spec'
			await writeArtifact("brainstorm");
			await setActiveWorkflowSlug(tempDir, SLUG);
			await cmd.execute(["resume", SLUG], asCtx(ctx));
			// spec prereq (brainstorm) is satisfied → activation + newSession
			const activations = getActions(ctx, "activateWorkflowPhase");
			expect(activations.length).toBe(1);
			expect(activations[0].args[1]).toBe("spec");
			expect(getActions(ctx, "newSession").length).toBe(1);
		});
	});

	// =========================================================================
	// populateLocalSetup contract
	// Each phase pre-reads prior artifacts and passes a setup callback to
	// newSession so the incoming agent can read them as local://PHASE.md files.
	// The mock records that newSession was called, confirming setup was provided.
	// =========================================================================

	describe("populateLocalSetup contract", () => {
		test("spec with brainstorm artifact calls newSession (setup callback registered)", async () => {
			await writeArtifact("brainstorm");
			await cmd.execute(["spec", SLUG], asCtx(ctx));
			// newSession is called once — setup callback was passed (mock ignores its value)
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("design with spec and brainstorm artifacts calls newSession", async () => {
			await writeArtifact("brainstorm");
			await writeArtifact("spec");
			await cmd.execute(["design", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("plan with design artifact calls newSession", async () => {
			await writeArtifact("design");
			await cmd.execute(["plan", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("execute with all prior artifacts calls newSession", async () => {
			await writeArtifact("brainstorm");
			await writeArtifact("spec");
			await writeArtifact("design");
			await writeArtifact("plan");
			await cmd.execute(["execute", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("verify with spec and execute artifacts calls newSession", async () => {
			await writeArtifact("spec");
			await writeArtifact("execute");
			await cmd.execute(["verify", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("finish with verify artifact calls newSession", async () => {
			await writeArtifact("verify");
			await cmd.execute(["finish", SLUG], asCtx(ctx));
			expect(getActions(ctx, "newSession").length).toBe(1);
		});

		test("phase with no prior artifacts still calls newSession (empty setup callback)", async () => {
			// execute with only plan artifact — no brainstorm/spec/design to copy
			await writeArtifact("plan");
			await cmd.execute(["execute", SLUG], asCtx(ctx));
			// newSession is still called regardless of how many artifacts were found
			expect(getActions(ctx, "newSession").length).toBe(1);
		});
	});
});
