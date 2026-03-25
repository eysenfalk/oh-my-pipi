/**
 * InteractiveMode orchestration tests.
 *
 * Tests the full call chain:
 *   handleExitPlanModeTool → #handleWorkflowPhaseComplete → approval gate → #handleApprovalResult
 *   → writeWorkflowArtifact → "Continue to next?" flow
 *
 * No LLM calls. All UI interactions are queued via the harness.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createWorkflowState,
	listWorkflows,
	readWorkflowState,
	writeWorkflowArtifact,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";
import { createInteractiveModeHarness, type InteractiveModeHarness } from "./interactive-mode-harness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRAINSTORM_CONTENT = "# Brainstorm\n\nIdeas explored here.";
const SPEC_CONTENT = "# Spec\n\nRequirements here.";

async function makeHarness(overrides?: Record<string, unknown>): Promise<InteractiveModeHarness> {
	return createInteractiveModeHarness(overrides);
}

// ---------------------------------------------------------------------------
// handleExitPlanModeTool — top-level routing
// ---------------------------------------------------------------------------

describe("InteractiveMode workflow orchestration", () => {
	let harness: InteractiveModeHarness;

	afterEach(async () => {
		await harness?.dispose();
	});

	// =========================================================================
	// handleExitPlanModeTool — basic routing
	// =========================================================================

	describe("handleExitPlanModeTool", () => {
		it("workflow phase completion — reads plan file and runs approval gate", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "test-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			// approval=none → no approval selector; "Continue to next?" still shown
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "test-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactExists("test-slug", "brainstorm");
			expect(harness.captures.statuses.some(s => s.includes("brainstorm"))).toBe(true);
		});

		it("workflow phase — invalid phase name shows warning", async () => {
			harness = await makeHarness();

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "test-slug",
				workflowPhase: "invalid-phase",
			});

			expect(harness.captures.warnings.some(w => w.includes("invalid-phase"))).toBe(true);
			expect(harness.captures.errors).toHaveLength(0);
		});

		it("workflow phase — missing plan file shows error", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "test-slug");
			// Intentionally do NOT write the plan file

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: false,
				workflowSlug: "test-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.errors.some(e => e.includes("not found") || e.includes("BRAINSTORM.md"))).toBe(true);
			await harness.assertArtifactMissing("test-slug", "brainstorm");
		});

		it("non-workflow — plan mode not enabled shows warning", async () => {
			harness = await makeHarness();
			// No workflowSlug/workflowPhase; planModeEnabled defaults to false

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: false,
			});

			expect(harness.captures.warnings.some(w => w.includes("Plan mode is not active"))).toBe(true);
		});

		it("uses explicit planFilePath from details when provided", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "custom-slug");
			// Write at a non-default name
			await harness.writePlanFile("CUSTOM_OUTPUT.md", "# Custom content");

			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://CUSTOM_OUTPUT.md",
				planExists: true,
				workflowSlug: "custom-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactContent("custom-slug", "brainstorm", "# Custom content");
		});

		it("defaults to local://{PHASE}.md when no planFilePath provided", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "default-slug");
			// Write at the default location the orchestration expects
			await harness.writePlanFile("BRAINSTORM.md", "# Default plan content");

			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: undefined as unknown as string,
				planExists: true,
				workflowSlug: "default-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactContent("default-slug", "brainstorm", "# Default plan content");
		});
	});

	// =========================================================================
	// #handleWorkflowPhaseComplete — approval modes
	// =========================================================================

	describe("#handleWorkflowPhaseComplete — approval modes", () => {
		it("approval mode none — auto-approves without showing approval selector", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "no-approval-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			// Only the "Continue to next?" selector should appear
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "no-approval-slug",
				workflowPhase: "brainstorm",
			});

			// Artifact written without an explicit approval step
			await harness.assertArtifactExists("no-approval-slug", "brainstorm");

			// The only selector shown is the "Continue to?" prompt, not an Approve/Refine/Reject
			expect(harness.captures.selectorCalls).toHaveLength(1);
			expect(harness.captures.selectorCalls[0]!.title).toContain("Continue to");
		});

		it("approval mode user — shows Approve/Refine/Reject selector", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "user" });
			await createWorkflowState(harness.cwd, "user-approval-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.queueSelectorResponse("Approve"); // approval selector
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "user-approval-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactExists("user-approval-slug", "brainstorm");
			expect(
				harness.captures.selectorCalls.some(
					s => s.options.includes("Approve") && s.options.includes("Refine") && s.options.includes("Reject"),
				),
			).toBe(true);
		});

		it("user approval — Refine triggers input prompt and returns refinement text as submission", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "user" });
			await createWorkflowState(harness.cwd, "refine-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.queueSelectorResponse("Refine"); // approval selector → triggers input
			harness.queueInputResponse("please add more detail"); // refinement reason

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "refine-slug",
				workflowPhase: "brainstorm",
			});

			// Refinement reason submitted as a message
			expect(harness.captures.submissions.some(s => s.text.includes("please add more detail"))).toBe(true);
			expect(harness.captures.inputCalls.length).toBeGreaterThanOrEqual(1);
			// No artifact — not approved
			await harness.assertArtifactMissing("refine-slug", "brainstorm");
		});

		it("user approval — Reject → Retry with feedback submits rejection reason", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "user" });
			await createWorkflowState(harness.cwd, "reject-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.queueSelectorResponse("Reject"); // approval selector
			harness.queueSelectorResponse("Retry phase"); // rejection action

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "reject-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.submissions.some(s => s.text.includes("Rejected"))).toBe(true);
			await harness.assertArtifactMissing("reject-slug", "brainstorm");
		});

		it("approval mode agent — returns review prompt via onInputCallback without writing artifact", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "agent" });
			await createWorkflowState(harness.cwd, "agent-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "agent-slug",
				workflowPhase: "brainstorm",
			});

			// Review prompt submitted — agent must evaluate
			expect(harness.captures.submissions).toHaveLength(1);
			expect(harness.captures.submissions[0]!.text).toContain("brainstorm phase output is ready for review");
			// No selector calls — agent mode doesn't ask the user
			expect(harness.captures.selectorCalls).toHaveLength(0);
			// No artifact written yet
			await harness.assertArtifactMissing("agent-slug", "brainstorm");
		});

		it("agent review — reviewCompleted=true bypasses runApprovalGate and goes to user approval", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "agent" });
			await createWorkflowState(harness.cwd, "review-done-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.queueSelectorResponse("Approve"); // user approval selector
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "review-done-slug",
				workflowPhase: "brainstorm",
				reviewCompleted: true,
			});

			await harness.assertArtifactExists("review-done-slug", "brainstorm");
			// The user approval selector must have been shown (Approve/Refine/Reject)
			expect(
				harness.captures.selectorCalls.some(s => s.options.includes("Approve") && s.options.includes("Refine")),
			).toBe(true);
		});

		it("review rounds — maxReviewRounds reached escalates to user approval", async () => {
			harness = await makeHarness({
				"workflow.phases.brainstorm.approval": "agent",
				"workflow.phases.brainstorm.maxReviewRounds": 2,
			});
			await createWorkflowState(harness.cwd, "max-rounds-slug");

			// Round 1: review prompt submitted, no artifact
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "max-rounds-slug",
				workflowPhase: "brainstorm",
			});
			expect(harness.captures.submissions).toHaveLength(1);
			await harness.assertArtifactMissing("max-rounds-slug", "brainstorm");

			// Round 2: hits maxRounds (2), escalates to user approval
			harness.resetCaptures();
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Approve"); // escalated user approval
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "max-rounds-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.warnings.some(w => w.includes("Maximum 2 review round"))).toBe(true);
			await harness.assertArtifactExists("max-rounds-slug", "brainstorm");
		});

		it("brainstorm phase proposal — Accept sets activePhases on artifact", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "proposal-accept-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.setProposePhases({ phases: ["brainstorm", "spec", "plan"], rationale: "Fast track" });
			harness.queueSelectorResponse("Accept"); // proposal selector
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "proposal-accept-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactExists("proposal-accept-slug", "brainstorm");
			await harness.assertWorkflowState("proposal-accept-slug", {
				activePhases: ["brainstorm", "spec", "plan"] as never,
			});
		});

		it("brainstorm phase proposal — Edit phases parses comma/space-separated input", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "proposal-edit-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.setProposePhases({ phases: ["brainstorm", "spec", "design", "plan"], rationale: "Full" });
			harness.queueSelectorResponse("Edit phases"); // proposal selector
			harness.queueInputResponse("brainstorm, spec, design"); // edited phases input
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "proposal-edit-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertWorkflowState("proposal-edit-slug", {
				activePhases: ["brainstorm", "spec", "design"] as never,
			});
		});

		it("brainstorm phase proposal — Reject uses global settings (no activePhases)", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "proposal-reject-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.setProposePhases({ phases: ["brainstorm", "spec"], rationale: "Minimal" });
			harness.queueSelectorResponse("Reject (use global settings)"); // proposal selector
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "proposal-reject-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactExists("proposal-reject-slug", "brainstorm");
			const state = await readWorkflowState(harness.cwd, "proposal-reject-slug");
			// activePhases must not be set — global settings take effect
			expect(state!.activePhases).toBeUndefined();
		});
	});

	// =========================================================================
	// #handleApprovalResult — post-approval outcomes
	// =========================================================================

	describe("#handleApprovalResult", () => {
		it("approved — writes artifact file to disk", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "artifact-disk-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "artifact-disk-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactContent("artifact-disk-slug", "brainstorm", BRAINSTORM_CONTENT);
		});

		it("approved — state.json updated with artifact path", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "state-update-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "state-update-slug",
				workflowPhase: "brainstorm",
			});

			const state = await readWorkflowState(harness.cwd, "state-update-slug");
			expect(state).not.toBeNull();
			expect(state!.artifacts.brainstorm).toBeDefined();
		});

		it("approved — offers Continue to next phase with correct next phase name", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "continue-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Continue"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "continue-slug",
				workflowPhase: "brainstorm",
			});

			const continueSelector = harness.captures.selectorCalls.find(s => s.title.includes("Continue to"));
			expect(continueSelector).toBeDefined();
			expect(continueSelector!.title).toContain("spec"); // next phase after brainstorm
			expect(continueSelector!.options).toEqual(["Continue", "Stop here"]);
		});

		it("approved — Continue sets editor text to /workflow command", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "editor-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Continue");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "editor-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.editorTexts).toContain("/workflow spec editor-slug");
		});

		it("approved — Stop here does not set editor text", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "stop-here-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "stop-here-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.editorTexts).toHaveLength(0);
		});

		it("approved — last phase (finish) does not offer continue", async () => {
			harness = await makeHarness({ "workflow.phases.finish.approval": "none" });
			// Write all prerequisite artifacts
			const slug = "finish-phase-slug";
			await writeWorkflowArtifact(harness.cwd, slug, "brainstorm", "b");
			await writeWorkflowArtifact(harness.cwd, slug, "spec", "s");
			await writeWorkflowArtifact(harness.cwd, slug, "design", "d");
			await writeWorkflowArtifact(harness.cwd, slug, "plan", "p");
			await writeWorkflowArtifact(harness.cwd, slug, "execute", "e");
			await writeWorkflowArtifact(harness.cwd, slug, "verify", "v");
			await harness.writePlanFile("FINISH.md", "# Finish");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://FINISH.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "finish",
			});

			// No "Continue to?" selector — finish is the last phase
			expect(harness.captures.selectorCalls.some(s => s.title.includes("Continue to"))).toBe(false);
		});

		it("not approved with reason — submits refinement as message without writing artifact", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "user" });
			await createWorkflowState(harness.cwd, "refine-reason-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Refine");
			harness.queueInputResponse("fix the intro");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "refine-reason-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.submissions.some(s => s.text.includes("fix the intro"))).toBe(true);
			await harness.assertArtifactMissing("refine-reason-slug", "brainstorm");
		});

		it("not approved without reason — silent return, no submissions, no artifact", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "user" });
			await createWorkflowState(harness.cwd, "silent-reject-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			// Reject → Abandon phase returns reason "Phase abandoned." which IS a reason
			// To get no-reason path: cancelled second dialog (undefined)
			harness.queueSelectorResponse("Reject"); // approval selector
			harness.queueSelectorResponse(undefined); // cancelled second dialog → no reason

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "silent-reject-slug",
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.submissions).toHaveLength(0);
			expect(harness.captures.errors).toHaveLength(0);
			await harness.assertArtifactMissing("silent-reject-slug", "brainstorm");
		});
	});

	// =========================================================================
	// handleStartWorkflowTool
	// =========================================================================

	describe("handleStartWorkflowTool", () => {
		it("creates workflow state and submits brainstorm prompt", async () => {
			harness = await makeHarness();

			harness.queueInputResponse("my-feature-slug"); // slug confirmation

			await harness.handleStartWorkflowTool({ topic: "Build a widget", slug: "my-feature-slug" });

			const state = await readWorkflowState(harness.cwd, "my-feature-slug");
			expect(state).not.toBeNull();
			expect(state!.slug).toBe("my-feature-slug");
			expect(harness.captures.submissions).toHaveLength(1);
			expect(harness.captures.submissions[0]!.text).toContain("my-feature-slug");
		});

		it("empty slug input — falls back to recommended slug", async () => {
			harness = await makeHarness();

			harness.queueInputResponse(""); // empty → falls back to recommendedSlug

			await harness.handleStartWorkflowTool({ topic: "Some feature", slug: "some-feature" });

			// Workflow should have been created with the recommended slug ("some-feature")
			const state = await readWorkflowState(harness.cwd, "some-feature");
			expect(state).not.toBeNull();
			expect(state!.slug).toBe("some-feature");
		});

		it("cancelled slug input (undefined) — returns without creating state", async () => {
			harness = await makeHarness();

			harness.queueInputResponse(undefined); // cancelled

			await harness.handleStartWorkflowTool({ topic: "Some feature", slug: "some-feature" });

			const state = await readWorkflowState(harness.cwd, "some-feature");
			expect(state).toBeNull();
			expect(harness.captures.submissions).toHaveLength(0);
		});

		it("collision — Overwrite creates fresh state", async () => {
			harness = await makeHarness();
			const slug = "collision-slug";
			await createWorkflowState(harness.cwd, slug);

			harness.queueInputResponse(slug); // confirm same slug
			harness.queueSelectorResponse("Overwrite"); // collision selector

			await harness.handleStartWorkflowTool({ topic: "Rebuild it", slug });

			const state = await readWorkflowState(harness.cwd, slug);
			expect(state).not.toBeNull();
			// Fresh state: no artifacts
			expect(Object.keys(state!.artifacts)).toHaveLength(0);
			expect(harness.captures.submissions).toHaveLength(1);
		});

		it("collision — Cancel preserves existing state without submitting prompt", async () => {
			harness = await makeHarness();
			const slug = "preserve-slug";
			await createWorkflowState(harness.cwd, slug);
			// Write an artifact to prove state survives
			await writeWorkflowArtifact(harness.cwd, slug, "brainstorm", "original brainstorm");

			harness.queueInputResponse(slug); // confirm same slug
			harness.queueSelectorResponse("Cancel"); // cancel overwrite

			await harness.handleStartWorkflowTool({ topic: "Try again", slug });

			const state = await readWorkflowState(harness.cwd, slug);
			expect(state!.artifacts.brainstorm).toBeDefined();
			expect(harness.captures.submissions).toHaveLength(0);
		});
	});

	// =========================================================================
	// handleSwitchWorkflowTool
	// =========================================================================

	describe("handleSwitchWorkflowTool", () => {
		it("switches to existing workflow and shows status", async () => {
			harness = await makeHarness();
			const slug = "switch-target-slug";
			await createWorkflowState(harness.cwd, slug);

			harness.queueSelectorResponse("Yes, switch"); // confirmation selector

			await harness.handleSwitchWorkflowTool({ slug });

			expect(harness.captures.statuses.some(s => s.includes(slug))).toBe(true);
			expect(harness.captures.errors).toHaveLength(0);
		});

		it("non-existent workflow — shows error with slug in message", async () => {
			harness = await makeHarness();

			await harness.handleSwitchWorkflowTool({ slug: "does-not-exist" });

			expect(harness.captures.errors.some(e => e.includes("does-not-exist"))).toBe(true);
		});

		it("cancelled switch — no status change", async () => {
			harness = await makeHarness();
			const slug = "cancel-switch-slug";
			await createWorkflowState(harness.cwd, slug);

			harness.queueSelectorResponse("Cancel"); // decline switch

			await harness.handleSwitchWorkflowTool({ slug });

			expect(harness.captures.statuses).toHaveLength(0);
		});

		it("confirm=true — skips selector and shows status immediately", async () => {
			harness = await makeHarness();
			const slug = "confirm-switch-slug";
			await createWorkflowState(harness.cwd, slug);

			await harness.handleSwitchWorkflowTool({ slug, confirm: true });

			expect(harness.captures.selectorCalls).toHaveLength(0);
			expect(harness.captures.statuses.some(s => s.includes(slug))).toBe(true);
		});
	});

	// =========================================================================
	// User Journeys — multi-step scenarios
	// =========================================================================

	describe("user journeys", () => {
		it("full phase: brainstorm → approve → Continue → editor set to spec command", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			await createWorkflowState(harness.cwd, "journey-slug");
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Continue");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: "journey-slug",
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactContent("journey-slug", "brainstorm", BRAINSTORM_CONTENT);
			expect(harness.captures.editorTexts).toContain("/workflow spec journey-slug");
		});

		it("two-phase journey: brainstorm then spec both produce artifacts", async () => {
			harness = await makeHarness({
				"workflow.phases.brainstorm.approval": "none",
				"workflow.phases.spec.approval": "none",
			});
			const slug = "two-phase-slug";
			await createWorkflowState(harness.cwd, slug);
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "brainstorm",
			});
			await harness.assertArtifactContent(slug, "brainstorm", BRAINSTORM_CONTENT);

			harness.resetCaptures();
			await harness.writePlanFile("SPEC.md", SPEC_CONTENT);
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://SPEC.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "spec",
			});
			await harness.assertArtifactContent(slug, "spec", SPEC_CONTENT);

			const state = await readWorkflowState(harness.cwd, slug);
			expect(state!.artifacts.brainstorm).toBeDefined();
			expect(state!.artifacts.spec).toBeDefined();
		});

		it("refinement loop: Refine → submit feedback → re-call → Approve writes artifact", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "user" });
			const slug = "refine-loop-slug";
			await createWorkflowState(harness.cwd, slug);
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			// Round 1: Refine
			harness.queueSelectorResponse("Refine");
			harness.queueInputResponse("fix the intro");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.submissions.some(s => s.text.includes("fix the intro"))).toBe(true);
			await harness.assertArtifactMissing(slug, "brainstorm");

			// Round 2: Approve (agent rewrote and re-calls exit_plan_mode)
			harness.resetCaptures();
			await harness.writePlanFile("BRAINSTORM.md", "# Revised brainstorm");
			harness.queueSelectorResponse("Approve");
			harness.queueSelectorResponse("Stop here");

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactContent(slug, "brainstorm", "# Revised brainstorm");
		});

		it("agent review → maxRounds escalation → user approval → artifact written", async () => {
			harness = await makeHarness({
				"workflow.phases.brainstorm.approval": "agent",
				"workflow.phases.brainstorm.maxReviewRounds": 2,
			});
			const slug = "escalation-journey-slug";
			await createWorkflowState(harness.cwd, slug);

			// Round 1: review prompt submitted
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "brainstorm",
			});
			expect(harness.captures.submissions).toHaveLength(1);
			await harness.assertArtifactMissing(slug, "brainstorm");

			// Round 2: hits maxRounds (2), escalates
			harness.resetCaptures();
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);
			harness.queueSelectorResponse("Approve"); // escalated user approval
			harness.queueSelectorResponse("Stop here"); // continue selector

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "brainstorm",
			});

			expect(harness.captures.warnings.some(w => w.includes("Maximum 2 review round"))).toBe(true);
			await harness.assertArtifactExists(slug, "brainstorm");
		});

		it("brainstorm with phase proposal → Accept → approve (none) → Continue to spec", async () => {
			harness = await makeHarness({ "workflow.phases.brainstorm.approval": "none" });
			const slug = "proposal-journey-slug";
			await createWorkflowState(harness.cwd, slug);
			await harness.writePlanFile("BRAINSTORM.md", BRAINSTORM_CONTENT);

			harness.setProposePhases({ phases: ["brainstorm", "spec", "plan"], rationale: "Minimal path" });
			harness.queueSelectorResponse("Accept"); // proposal selector
			harness.queueSelectorResponse("Continue"); // continue to spec

			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
				workflowSlug: slug,
				workflowPhase: "brainstorm",
			});

			await harness.assertArtifactExists(slug, "brainstorm");
			await harness.assertWorkflowState(slug, {
				activePhases: ["brainstorm", "spec", "plan"] as never,
			});
			// Next phase after brainstorm in activePhases ["brainstorm","spec","plan"] is "spec"
			expect(harness.captures.editorTexts).toContain(`/workflow spec ${slug}`);
		});
	});
	// =========================================================================
	// handleStartWorkflowTool — slug placeholder; handleExitPlanModeTool fallback
	// =========================================================================

	describe("workflow slug and exit_plan_mode fallback", () => {
		it("handleStartWorkflowTool passes recommended slug as placeholder", async () => {
			harness = await makeHarness();

			// Queue input response (confirm the slug)
			harness.queueInputResponse("my-cool-feature-slug");
			await harness.handleStartWorkflowTool({ topic: "My Cool Feature" });

			// showHookInput should have been called once with the generated slug as placeholder
			expect(harness.captures.inputCalls.length).toBe(1);
			const inputCall = harness.captures.inputCalls[0]!;
			expect(inputCall.placeholder).toBeDefined();
			// Placeholder should contain a date-prefixed sanitized version of the topic
			expect(inputCall.placeholder).toMatch(/^\d{4}-\d{2}-\d{2}-my-cool-feature/);
		});

		it("handleStartWorkflowTool uses recommended slug when user submits empty input", async () => {
			harness = await makeHarness();

			// Queue empty string (user pressed Enter without typing in the slug field)
			harness.queueInputResponse("");
			await harness.handleStartWorkflowTool({ topic: "My Cool Feature" });

			// Should have created the workflow with the recommended slug, not failed silently
			const inputCall = harness.captures.inputCalls[0]!;
			const recommendedSlug = inputCall.placeholder!;

			// Workflow state should exist with the recommended slug
			const state = await readWorkflowState(harness.cwd, recommendedSlug);
			expect(state).not.toBeNull();
			expect(state!.slug).toBe(recommendedSlug);
			expect(state!.currentPhase).toBe("brainstorm");
		});

		it("handleStartWorkflowTool returns silently when user cancels slug input", async () => {
			harness = await makeHarness();

			// Queue undefined (user pressed Escape)
			harness.queueInputResponse(undefined);
			await harness.handleStartWorkflowTool({ topic: "My Feature" });

			// No workflow should have been created
			const workflows = await listWorkflows(harness.cwd);
			expect(workflows).toHaveLength(0);
		});

		it("exit_plan_mode falls back to active workflow when agent omits params", async () => {
			harness = await makeHarness();
			await createWorkflowState(harness.cwd, "test-slug");

			// Set active workflow context (simulates a prior phase completing)
			harness.setActiveWorkflow("test-slug", "brainstorm", null);
			await harness.writePlanFile("BRAINSTORM.md", "# Brainstorm output");

			// Default approval mode is "user" — queue Approve then Stop here
			harness.queueSelectorResponse("Approve");
			harness.queueSelectorResponse("Stop here");

			// Call handleExitPlanModeTool WITHOUT workflowSlug/workflowPhase
			await harness.handleExitPlanModeTool({
				planFilePath: "local://BRAINSTORM.md",
				planExists: true,
			});

			// Should NOT show 'Plan mode is not active' warning — fallback resolved the context
			expect(harness.captures.warnings).not.toContain("Plan mode is not active.");

			// Should have completed the workflow phase (artifact written)
			await harness.assertArtifactExists("test-slug", "brainstorm");
		});

		it("exit_plan_mode without workflow or plan mode shows warning", async () => {
			harness = await makeHarness();

			await harness.handleExitPlanModeTool({
				planFilePath: "local://PLAN.md",
				planExists: true,
			});

			expect(harness.captures.warnings).toContain("Plan mode is not active.");
		});
	});
});
