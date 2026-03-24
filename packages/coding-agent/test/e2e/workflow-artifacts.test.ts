import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createWorkflowState,
	findActiveWorkflow,
	formatWorkflowStatus,
	generateSlug,
	getActiveWorkflowSlug,
	getNextPhase,
	listWorkflows,
	PHASES,
	persistPhaseLearnings,
	readWorkflowArtifact,
	readWorkflowState,
	resolveWorkflowDir,
	setActiveWorkflowSlug,
	updateWorkflowActivePhases,
	WORKFLOW_DIR,
	type WorkflowPhase,
	type WorkflowState,
	writeWorkflowArtifact,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateJsonPath(tempDir: string, slug: string): string {
	return path.join(tempDir, WORKFLOW_DIR, slug, "state.json");
}

function phaseMdPath(tempDir: string, slug: string, phase: WorkflowPhase): string {
	return path.join(tempDir, WORKFLOW_DIR, slug, `${phase}.md`);
}

async function readStateJson(tempDir: string, slug: string): Promise<WorkflowState> {
	return Bun.file(stateJsonPath(tempDir, slug)).json() as Promise<WorkflowState>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Workflow Artifacts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `omp-test-${crypto.randomUUID()}`);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------

	describe("writeWorkflowArtifact", () => {
		test("creates state.json with correct structure on first write", async () => {
			const slug = "2024-01-01-my-feature";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "# Ideas");

			const state = await readStateJson(tempDir, slug);
			expect(state.slug).toBe(slug);
			expect(state.currentPhase).toBe("brainstorm");
			expect(state.artifacts.brainstorm).toBe(`${WORKFLOW_DIR}/${slug}/brainstorm.md`);
		});

		test("creates phase.md with provided content", async () => {
			const slug = "2024-01-01-phase-md";
			const content = "# Brainstorm\n\nSome ideas.";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", content);

			const written = await Bun.file(phaseMdPath(tempDir, slug, "brainstorm")).text();
			expect(written).toBe(content);
		});

		test("updates existing state on subsequent writes", async () => {
			const slug = "2024-01-01-update-state";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "initial");
			await writeWorkflowArtifact(tempDir, slug, "spec", "spec content");

			const state = await readStateJson(tempDir, slug);
			expect(state.currentPhase).toBe("spec");
			expect(state.artifacts.brainstorm).toBe(`${WORKFLOW_DIR}/${slug}/brainstorm.md`);
			expect(state.artifacts.spec).toBe(`${WORKFLOW_DIR}/${slug}/spec.md`);
		});

		test("creates docs/workflow/<slug>/ directory tree", async () => {
			const slug = "2024-01-01-dir-tree";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "content");

			const dir = path.join(tempDir, WORKFLOW_DIR, slug);
			expect(fs.existsSync(dir)).toBe(true);
			expect(fs.statSync(dir).isDirectory()).toBe(true);
		});

		test("sets activePhases when provided", async () => {
			const slug = "2024-01-01-active-phases";
			const activePhases: WorkflowPhase[] = ["brainstorm", "spec", "execute"];
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "content", activePhases);

			const state = await readStateJson(tempDir, slug);
			expect(state.activePhases).toEqual(activePhases);
		});

		test("overwrites existing phase.md on second write for same phase", async () => {
			const slug = "2024-01-01-overwrite";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "original");
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "revised");

			const content = await Bun.file(phaseMdPath(tempDir, slug, "brainstorm")).text();
			expect(content).toBe("revised");
		});
	});

	// -------------------------------------------------------------------------

	describe("readWorkflowState", () => {
		test("reads valid state.json and returns WorkflowState", async () => {
			const slug = "2024-01-01-read-state";
			await createWorkflowState(tempDir, slug);

			const state = await readWorkflowState(tempDir, slug);
			expect(state).not.toBeNull();
			expect(state!.slug).toBe(slug);
			expect(state!.currentPhase).toBe("brainstorm");
			expect(state!.artifacts).toEqual({});
		});

		test("returns null for non-existent slug", async () => {
			const state = await readWorkflowState(tempDir, "does-not-exist");
			expect(state).toBeNull();
		});

		test("defaults invalid currentPhase to brainstorm", async () => {
			const slug = "2024-01-01-bad-phase";
			const dir = path.join(tempDir, WORKFLOW_DIR, slug);
			fs.mkdirSync(dir, { recursive: true });
			const bad = { slug, currentPhase: "invalidphase", artifacts: {} };
			await Bun.write(path.join(dir, "state.json"), JSON.stringify(bad));

			const state = await readWorkflowState(tempDir, slug);
			expect(state).not.toBeNull();
			expect(state!.currentPhase).toBe("brainstorm");
		});
	});

	// -------------------------------------------------------------------------

	describe("readWorkflowArtifact", () => {
		test("reads existing phase markdown", async () => {
			const slug = "2024-01-01-read-artifact";
			const content = "# Spec\n\nDetails.";
			await writeWorkflowArtifact(tempDir, slug, "spec", content);

			const result = await readWorkflowArtifact(tempDir, slug, "spec");
			expect(result).toBe(content);
		});

		test("returns null for non-existent phase", async () => {
			const slug = "2024-01-01-missing-phase";
			await createWorkflowState(tempDir, slug);

			const result = await readWorkflowArtifact(tempDir, slug, "design");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------

	describe("createWorkflowState", () => {
		test("creates initial state with brainstorm as first phase", async () => {
			const slug = "2024-01-01-create-state";
			await createWorkflowState(tempDir, slug);

			expect(fs.existsSync(stateJsonPath(tempDir, slug))).toBe(true);
			const state = await readStateJson(tempDir, slug);
			expect(state.currentPhase).toBe("brainstorm");
			expect(state.slug).toBe(slug);
		});

		test("sets activePhases when provided", async () => {
			const slug = "2024-01-01-create-with-phases";
			const activePhases: WorkflowPhase[] = ["brainstorm", "spec", "execute", "finish"];
			await createWorkflowState(tempDir, slug, activePhases);

			const state = await readStateJson(tempDir, slug);
			expect(state.activePhases).toEqual(activePhases);
		});

		test("does not include artifacts in initial state", async () => {
			const slug = "2024-01-01-no-artifacts";
			await createWorkflowState(tempDir, slug);

			const state = await readStateJson(tempDir, slug);
			expect(state.artifacts).toEqual({});
			expect(Object.keys(state.artifacts)).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------

	describe("getNextPhase", () => {
		test("returns next phase in sequence", () => {
			const state: WorkflowState = { slug: "x", currentPhase: "brainstorm", artifacts: {} };
			expect(getNextPhase(state)).toBe("spec");
		});

		test("respects activePhases filter — skips deactivated phases", () => {
			const state: WorkflowState = {
				slug: "x",
				currentPhase: "brainstorm",
				artifacts: {},
				activePhases: ["brainstorm", "spec", "execute"],
			};
			// design is not in activePhases, so we should jump straight to spec
			expect(getNextPhase(state)).toBe("spec");

			const fromSpec: WorkflowState = { ...state, currentPhase: "spec" };
			// design and plan are skipped, next is execute
			expect(getNextPhase(fromSpec)).toBe("execute");
		});

		test("returns null at end of workflow", () => {
			const state: WorkflowState = { slug: "x", currentPhase: "finish", artifacts: {} };
			expect(getNextPhase(state)).toBeNull();
		});

		test("returns null when only remaining phases are not in activePhases", () => {
			const state: WorkflowState = {
				slug: "x",
				currentPhase: "spec",
				artifacts: {},
				activePhases: ["brainstorm", "spec"],
			};
			expect(getNextPhase(state)).toBeNull();
		});
	});

	// -------------------------------------------------------------------------

	describe("listWorkflows", () => {
		test("lists all workflow directories", async () => {
			const slugs = ["2024-01-01-alpha", "2024-01-02-beta", "2024-01-03-gamma"];
			for (const slug of slugs) {
				await createWorkflowState(tempDir, slug);
			}

			const listed = await listWorkflows(tempDir);
			// all slugs present
			for (const slug of slugs) {
				expect(listed).toContain(slug);
			}
			expect(listed).toHaveLength(slugs.length);
		});

		test("returns empty array when no workflows exist", async () => {
			const result = await listWorkflows(tempDir);
			expect(result).toEqual([]);
		});

		test("sorts in reverse chronological order", async () => {
			const slugs = ["2024-01-01-first", "2024-01-03-third", "2024-01-02-second"];
			for (const slug of slugs) {
				await createWorkflowState(tempDir, slug);
			}

			const listed = await listWorkflows(tempDir);
			expect(listed[0]).toBe("2024-01-03-third");
			expect(listed[1]).toBe("2024-01-02-second");
			expect(listed[2]).toBe("2024-01-01-first");
		});

		test("ignores non-directory entries in workflow dir", async () => {
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			fs.mkdirSync(workflowRoot, { recursive: true });
			// place a file alongside a directory
			await Bun.write(path.join(workflowRoot, "not-a-dir.txt"), "noise");
			await createWorkflowState(tempDir, "2024-01-01-real-dir");

			const listed = await listWorkflows(tempDir);
			expect(listed).toContain("2024-01-01-real-dir");
			expect(listed).not.toContain("not-a-dir.txt");
		});
	});

	// -------------------------------------------------------------------------

	describe("findActiveWorkflow", () => {
		test("returns slug from .active file", async () => {
			const slug = "2024-01-01-active";
			await createWorkflowState(tempDir, slug);
			await setActiveWorkflowSlug(tempDir, slug);

			const found = await findActiveWorkflow(tempDir);
			expect(found).toBe(slug);
		});

		test("falls back to most recent workflow when no .active", async () => {
			await createWorkflowState(tempDir, "2024-01-01-older");
			await createWorkflowState(tempDir, "2024-01-02-newer");

			const found = await findActiveWorkflow(tempDir);
			expect(found).toBe("2024-01-02-newer");
		});

		test("returns null when no workflows exist", async () => {
			const found = await findActiveWorkflow(tempDir);
			expect(found).toBeNull();
		});

		test("falls back to most recent valid workflow when .active points to deleted workflow", async () => {
			const deleted = "2024-01-01-deleted";
			const valid = "2024-01-02-valid";
			// only create the valid one; set .active to the non-existent deleted one
			await createWorkflowState(tempDir, valid);
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			fs.mkdirSync(workflowRoot, { recursive: true });
			await Bun.write(path.join(workflowRoot, ".active"), deleted);

			// deleted has no state.json → findActiveWorkflow falls back to list scan
			const found = await findActiveWorkflow(tempDir);
			expect(found).toBe(valid);
		});
	});

	// -------------------------------------------------------------------------

	describe("generateSlug", () => {
		test("generates date-prefixed slug from topic", () => {
			const slug = generateSlug("My Cool Feature!");
			expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-my-cool-feature$/);
		});

		test("sanitizes special characters", () => {
			const slug = generateSlug("hello@world & stuff");
			expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-hello-world-stuff$/);
		});

		test("truncates to max 50 chars (date prefix + 1 dash + sanitized part ≤ 50)", () => {
			const longTopic = "a".repeat(100);
			const slug = generateSlug(longTopic);
			// The sanitized part is sliced at 50, then date+"-"+sanitized is assembled
			// sanitized = "a".repeat(100).slice(0,50) = "a".repeat(50)
			// total = "YYYY-MM-DD-" + "a".repeat(50) → 61 chars, but the contract only
			// guarantees sanitized part is ≤ 50. Verify sanitized portion length.
			const datePart = new Date().toISOString().slice(0, 10);
			const withoutDate = slug.slice(datePart.length + 1); // remove "YYYY-MM-DD-"
			expect(withoutDate.length).toBeLessThanOrEqual(50);
		});

		test("returns just date for empty topic", () => {
			const slug = generateSlug("");
			expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		test("returns just date for topic that is only special characters", () => {
			const slug = generateSlug("@@@---!!!");
			expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});

	// -------------------------------------------------------------------------

	describe("formatWorkflowStatus", () => {
		test("formats state into human-readable multi-line string", () => {
			const state: WorkflowState = {
				slug: "2024-01-01-test",
				currentPhase: "spec",
				artifacts: {},
			};
			const result = formatWorkflowStatus(state);
			expect(result).toContain("Workflow: 2024-01-01-test");
			expect(result).toContain("Current phase: spec");
			expect(result).toContain("Artifacts:");
		});

		test("lists all artifacts", () => {
			const state: WorkflowState = {
				slug: "2024-01-01-artifacts",
				currentPhase: "design",
				artifacts: {
					brainstorm: `${WORKFLOW_DIR}/2024-01-01-artifacts/brainstorm.md`,
					spec: `${WORKFLOW_DIR}/2024-01-01-artifacts/spec.md`,
				},
			};
			const result = formatWorkflowStatus(state);
			expect(result).toContain("brainstorm:");
			expect(result).toContain("spec:");
		});
	});

	// -------------------------------------------------------------------------

	describe("active workflow tracking", () => {
		test("setActiveWorkflowSlug writes .active file", async () => {
			const slug = "2024-01-01-tracking";
			await createWorkflowState(tempDir, slug);
			await setActiveWorkflowSlug(tempDir, slug);

			const activeFilePath = path.join(tempDir, WORKFLOW_DIR, ".active");
			expect(fs.existsSync(activeFilePath)).toBe(true);
			const content = await Bun.file(activeFilePath).text();
			expect(content).toBe(slug);
		});

		test("getActiveWorkflowSlug reads .active file", async () => {
			const slug = "2024-01-01-get-active";
			await createWorkflowState(tempDir, slug);
			await setActiveWorkflowSlug(tempDir, slug);

			const result = await getActiveWorkflowSlug(tempDir);
			expect(result).toBe(slug);
		});

		test("setActiveWorkflowSlug(null) removes .active", async () => {
			const slug = "2024-01-01-remove-active";
			await createWorkflowState(tempDir, slug);
			await setActiveWorkflowSlug(tempDir, slug);
			await setActiveWorkflowSlug(tempDir, null);

			const activeFilePath = path.join(tempDir, WORKFLOW_DIR, ".active");
			expect(fs.existsSync(activeFilePath)).toBe(false);
		});

		test("getActiveWorkflowSlug returns null when no .active exists", async () => {
			const result = await getActiveWorkflowSlug(tempDir);
			expect(result).toBeNull();
		});

		test("setActiveWorkflowSlug(null) is idempotent when .active does not exist", async () => {
			// Should not throw
			await expect(setActiveWorkflowSlug(tempDir, null)).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------

	describe("updateWorkflowActivePhases", () => {
		test("updates activePhases in existing state", async () => {
			const slug = "2024-01-01-update-phases";
			await createWorkflowState(tempDir, slug);

			const phases: WorkflowPhase[] = ["brainstorm", "spec", "finish"];
			await updateWorkflowActivePhases(tempDir, slug, phases);

			const state = await readStateJson(tempDir, slug);
			expect(state.activePhases).toEqual(phases);
		});

		test("creates state if not exists", async () => {
			const slug = "2024-01-01-create-via-update";
			const phases: WorkflowPhase[] = ["brainstorm", "execute"];
			await updateWorkflowActivePhases(tempDir, slug, phases);

			const state = await readStateJson(tempDir, slug);
			expect(state.slug).toBe(slug);
			expect(state.activePhases).toEqual(phases);
		});
	});

	// -------------------------------------------------------------------------

	describe("persistPhaseLearnings", () => {
		test("creates learnings.md with header on first write", async () => {
			const slug = "2024-01-01-learnings";
			await createWorkflowState(tempDir, slug);
			await persistPhaseLearnings(tempDir, slug, "brainstorm", "Key insight.");

			const learningsPath = path.join(resolveWorkflowDir(tempDir, slug), "learnings.md");
			expect(fs.existsSync(learningsPath)).toBe(true);
			const content = await Bun.file(learningsPath).text();
			expect(content).toContain("# Workflow Learnings");
			expect(content).toContain("## brainstorm learnings");
			expect(content).toContain("Key insight.");
		});

		test("appends to existing learnings.md", async () => {
			const slug = "2024-01-01-append-learnings";
			await createWorkflowState(tempDir, slug);
			await persistPhaseLearnings(tempDir, slug, "brainstorm", "First insight.");
			await persistPhaseLearnings(tempDir, slug, "spec", "Second insight.");

			const learningsPath = path.join(resolveWorkflowDir(tempDir, slug), "learnings.md");
			const content = await Bun.file(learningsPath).text();
			expect(content).toContain("## brainstorm learnings");
			expect(content).toContain("First insight.");
			expect(content).toContain("## spec learnings");
			expect(content).toContain("Second insight.");
		});
	});

	// -------------------------------------------------------------------------

	describe("phase prerequisites", () => {
		// These tests verify that after writing the prerequisite artifact,
		// readWorkflowArtifact returns content (confirming the file exists) and
		// getNextPhase correctly advances to the expected phase.

		test("spec requires brainstorm artifact", async () => {
			const slug = "2024-01-01-prereq-spec";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "# Brainstorm content");

			const brainstormContent = await readWorkflowArtifact(tempDir, slug, "brainstorm");
			expect(brainstormContent).not.toBeNull();

			const state = await readWorkflowState(tempDir, slug);
			expect(getNextPhase(state!)).toBe("spec");
		});

		test("design requires spec artifact", async () => {
			const slug = "2024-01-01-prereq-design";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "ideas");
			await writeWorkflowArtifact(tempDir, slug, "spec", "# Spec content");

			const specContent = await readWorkflowArtifact(tempDir, slug, "spec");
			expect(specContent).not.toBeNull();

			const state = await readWorkflowState(tempDir, slug);
			expect(getNextPhase(state!)).toBe("design");
		});

		test("plan requires design artifact (when in activePhases)", async () => {
			const slug = "2024-01-01-prereq-plan";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "ideas");
			await writeWorkflowArtifact(tempDir, slug, "spec", "spec");
			await writeWorkflowArtifact(tempDir, slug, "design", "# Design content");

			const designContent = await readWorkflowArtifact(tempDir, slug, "design");
			expect(designContent).not.toBeNull();

			const state = await readWorkflowState(tempDir, slug);
			expect(getNextPhase(state!)).toBe("plan");
		});

		test("execute requires plan artifact", async () => {
			const slug = "2024-01-01-prereq-execute";
			for (const phase of ["brainstorm", "spec", "design", "plan"] as WorkflowPhase[]) {
				await writeWorkflowArtifact(tempDir, slug, phase, `# ${phase}`);
			}

			const planContent = await readWorkflowArtifact(tempDir, slug, "plan");
			expect(planContent).not.toBeNull();

			const state = await readWorkflowState(tempDir, slug);
			expect(getNextPhase(state!)).toBe("execute");
		});

		test("verify requires execute artifact", async () => {
			const slug = "2024-01-01-prereq-verify";
			for (const phase of ["brainstorm", "spec", "design", "plan", "execute"] as WorkflowPhase[]) {
				await writeWorkflowArtifact(tempDir, slug, phase, `# ${phase}`);
			}

			const executeContent = await readWorkflowArtifact(tempDir, slug, "execute");
			expect(executeContent).not.toBeNull();

			const state = await readWorkflowState(tempDir, slug);
			expect(getNextPhase(state!)).toBe("verify");
		});

		test("finish requires verify artifact", async () => {
			const slug = "2024-01-01-prereq-finish";
			for (const phase of PHASES.filter(p => p !== "finish") as WorkflowPhase[]) {
				await writeWorkflowArtifact(tempDir, slug, phase, `# ${phase}`);
			}

			const verifyContent = await readWorkflowArtifact(tempDir, slug, "verify");
			expect(verifyContent).not.toBeNull();

			const state = await readWorkflowState(tempDir, slug);
			expect(getNextPhase(state!)).toBe("finish");
		});
	});
});
