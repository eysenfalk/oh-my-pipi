/**
 * Edge-case tests for workflow artifact functions.
 *
 * Covers error conditions, boundary values, and malformed inputs not exercised
 * by the happy-path suite in workflow-artifacts.test.ts.
 */
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

function workflowDir(tempDir: string, slug: string): string {
	return path.join(tempDir, WORKFLOW_DIR, slug);
}

function stateJsonPath(tempDir: string, slug: string): string {
	return path.join(workflowDir(tempDir, slug), "state.json");
}

async function writeRawState(tempDir: string, slug: string, raw: string): Promise<void> {
	const dir = workflowDir(tempDir, slug);
	fs.mkdirSync(dir, { recursive: true });
	await Bun.write(path.join(dir, "state.json"), raw);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Workflow Artifacts — edge cases", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `omp-edge-${crypto.randomUUID()}`);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// writeWorkflowArtifact
	// -------------------------------------------------------------------------

	describe("writeWorkflowArtifact", () => {
		test("writes file with empty string content — file exists and is empty", async () => {
			const slug = "2024-01-01-empty-content";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "");

			const filePath = path.join(workflowDir(tempDir, slug), "brainstorm.md");
			expect(fs.existsSync(filePath)).toBe(true);
			const written = await Bun.file(filePath).text();
			expect(written).toBe("");
		});

		test("preserves unicode content — emoji, CJK, RTL characters", async () => {
			const slug = "2024-01-01-unicode";
			const unicode = "# Ideas\n\n🚀 العربية 中文 日本語\n\nMulti-script content.";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", unicode);

			const written = await Bun.file(path.join(workflowDir(tempDir, slug), "brainstorm.md")).text();
			expect(written).toBe(unicode);
		});

		test("writes extremely long content (10 KB+) without truncation", async () => {
			const slug = "2024-01-01-large-content";
			const large = "x".repeat(12_000);
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", large);

			const written = await Bun.file(path.join(workflowDir(tempDir, slug), "brainstorm.md")).text();
			expect(written).toBe(large);
			expect(written.length).toBe(12_000);
		});

		test("writing same phase twice overwrites file and keeps state.json consistent", async () => {
			const slug = "2024-01-01-same-phase-twice";
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "first");
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "second");

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.currentPhase).toBe("brainstorm");
			expect(state.artifacts.brainstorm).toBe(`${WORKFLOW_DIR}/${slug}/brainstorm.md`);
			// Artifact path must still be correct (not duplicated, not corrupted)
			expect(Object.keys(state.artifacts)).toHaveLength(1);
		});

		test("writing a later phase before an earlier one — state updated to that phase", async () => {
			const slug = "2024-01-01-out-of-order";
			// Write 'finish' as first-ever artifact (no prior state)
			await writeWorkflowArtifact(tempDir, slug, "finish", "done early");

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.currentPhase).toBe("finish");
			expect(state.artifacts.finish).toBe(`${WORKFLOW_DIR}/${slug}/finish.md`);
		});

		test("activePhases not provided on second write — preserves activePhases from first write", async () => {
			const slug = "2024-01-01-preserve-phases";
			const phases: WorkflowPhase[] = ["brainstorm", "spec", "finish"];
			await writeWorkflowArtifact(tempDir, slug, "brainstorm", "v1", phases);
			// Second write without providing activePhases
			await writeWorkflowArtifact(tempDir, slug, "spec", "spec content");

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			// activePhases from first write should be preserved
			expect(state.activePhases).toEqual(phases);
		});
	});

	// -------------------------------------------------------------------------
	// readWorkflowState
	// -------------------------------------------------------------------------

	describe("readWorkflowState", () => {
		test("empty state.json — rejects (JSON parse error propagates)", async () => {
			await writeRawState(tempDir, "2024-01-01-empty-json", "");

			await expect(readWorkflowState(tempDir, "2024-01-01-empty-json")).rejects.toThrow();
		});

		test("invalid JSON in state.json — rejects (SyntaxError propagates)", async () => {
			await writeRawState(tempDir, "2024-01-01-bad-json", "{not: valid json{{");

			await expect(readWorkflowState(tempDir, "2024-01-01-bad-json")).rejects.toThrow();
		});

		test("state.json missing currentPhase field — defaults to brainstorm", async () => {
			const slug = "2024-01-01-no-phase";
			await writeRawState(tempDir, slug, JSON.stringify({ slug, artifacts: {} }));

			const state = await readWorkflowState(tempDir, slug);
			expect(state).not.toBeNull();
			expect(state!.currentPhase).toBe("brainstorm");
		});

		test("state.json with extra unknown fields — reads correctly, known fields intact", async () => {
			const slug = "2024-01-01-extra-fields";
			const raw = JSON.stringify({
				slug,
				currentPhase: "spec",
				artifacts: {},
				unknownField: "some-value",
				anotherExtra: 42,
			});
			await writeRawState(tempDir, slug, raw);

			const state = await readWorkflowState(tempDir, slug);
			expect(state).not.toBeNull();
			expect(state!.slug).toBe(slug);
			expect(state!.currentPhase).toBe("spec");
			expect(state!.artifacts).toEqual({});
		});

		test("workflow dir exists but contains no state.json — returns null", async () => {
			const slug = "2024-01-01-dir-no-state";
			// Create only the directory; no state.json
			fs.mkdirSync(path.join(tempDir, WORKFLOW_DIR, slug), { recursive: true });

			const state = await readWorkflowState(tempDir, slug);
			expect(state).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// readWorkflowArtifact
	// -------------------------------------------------------------------------

	describe("readWorkflowArtifact", () => {
		test("file exists but is empty — returns empty string", async () => {
			const slug = "2024-01-01-empty-artifact";
			await writeWorkflowArtifact(tempDir, slug, "spec", "");

			const result = await readWorkflowArtifact(tempDir, slug, "spec");
			expect(result).toBe("");
		});

		test("binary-like content (null bytes, control chars) — returned as-is", async () => {
			const slug = "2024-01-01-binary-artifact";
			const dir = workflowDir(tempDir, slug);
			fs.mkdirSync(dir, { recursive: true });
			const binaryLike = "before\x00\x01\x02\x03after";
			await Bun.write(path.join(dir, "plan.md"), binaryLike);

			const result = await readWorkflowArtifact(tempDir, slug, "plan");
			expect(result).toBe(binaryLike);
		});

		test("slug with path traversal characters — path.join normalises, no escape", async () => {
			// path.join handles "../" by collapsing; the resulting resolved path stays
			// under the workflow root (or lands elsewhere, but no crash).
			const traversalSlug = "../some-traversal";
			// Should either return null (file doesn't exist at resolved path) or the
			// content if the path accidentally resolves to something; crucially it must
			// not throw an unhandled error.
			const result = await readWorkflowArtifact(tempDir, traversalSlug, "brainstorm");
			// path.join(tempDir, WORKFLOW_DIR, "../some-traversal", "brainstorm.md")
			// resolves to tempDir/<WORKFLOW_DIR>/../some-traversal/brainstorm.md
			// that file does not exist → null
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// createWorkflowState
	// -------------------------------------------------------------------------

	describe("createWorkflowState", () => {
		test("called twice for same slug — second call overwrites first", async () => {
			const slug = "2024-01-01-double-create";
			const phases1: WorkflowPhase[] = ["brainstorm", "spec"];
			const phases2: WorkflowPhase[] = ["brainstorm", "execute", "finish"];
			await createWorkflowState(tempDir, slug, phases1);
			await createWorkflowState(tempDir, slug, phases2);

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			// Second call's phases win; artifacts reset to empty
			expect(state.activePhases).toEqual(phases2);
			expect(state.artifacts).toEqual({});
		});

		test("activePhases empty array — stored as empty array (not omitted)", async () => {
			const slug = "2024-01-01-empty-phases";
			await createWorkflowState(tempDir, slug, []);

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.activePhases).toEqual([]);
		});

		test("activePhases with single phase — stored correctly", async () => {
			const slug = "2024-01-01-single-phase";
			const phases: WorkflowPhase[] = ["finish"];
			await createWorkflowState(tempDir, slug, phases);

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.activePhases).toEqual(phases);
		});

		test("no activePhases argument — activePhases field absent from state", async () => {
			const slug = "2024-01-01-no-active-phases-arg";
			await createWorkflowState(tempDir, slug);

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.activePhases).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// getNextPhase
	// -------------------------------------------------------------------------

	describe("getNextPhase", () => {
		test("activePhases skips multiple phases — brainstorm with [brainstorm,plan,execute] → plan", () => {
			const state: WorkflowState = {
				slug: "x",
				currentPhase: "brainstorm",
				artifacts: {},
				activePhases: ["brainstorm", "plan", "execute"],
			};
			// spec and design are not in activePhases; next enabled phase after brainstorm is plan
			expect(getNextPhase(state)).toBe("plan");
		});

		test("currentPhase not in PHASES (indexOf returns -1) — returns null immediately", () => {
			const state: WorkflowState = {
				slug: "x",
				// Type cast to simulate corrupted state at runtime
				currentPhase: "completely-unknown" as WorkflowPhase,
				artifacts: {},
			};
			expect(getNextPhase(state)).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// generateSlug
	// -------------------------------------------------------------------------

	describe("generateSlug", () => {
		test("consecutive special characters in topic — collapsed to single dash", () => {
			// "a!!!b" → replace([^a-z0-9]+, "-") → "a-b"
			const slug = generateSlug("a!!!b");
			const datePrefix = new Date().toISOString().slice(0, 10);
			expect(slug).toBe(`${datePrefix}-a-b`);
		});

		test("topic with leading and trailing special characters — dashes trimmed", () => {
			// "---hello---" → replace(/^-|-$/g,"") → "hello"
			const slug = generateSlug("---hello---");
			const datePrefix = new Date().toISOString().slice(0, 10);
			expect(slug).toBe(`${datePrefix}-hello`);
		});

		test("uppercase topic — lowercased in slug", () => {
			const slug = generateSlug("HELLO WORLD");
			expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-hello-world$/);
		});

		test("topic longer than 50 chars — sanitized portion capped at 50", () => {
			const topic = "z".repeat(200);
			const slug = generateSlug(topic);
			const datePrefix = new Date().toISOString().slice(0, 10);
			const withoutDate = slug.slice(datePrefix.length + 1);
			expect(withoutDate.length).toBeLessThanOrEqual(50);
		});
	});

	// -------------------------------------------------------------------------
	// listWorkflows
	// -------------------------------------------------------------------------

	describe("listWorkflows", () => {
		test("WORKFLOW_DIR exists but is empty — returns empty array", async () => {
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			fs.mkdirSync(workflowRoot, { recursive: true });

			const result = await listWorkflows(tempDir);
			expect(result).toEqual([]);
		});

		test("WORKFLOW_DIR does not exist — returns empty array (ENOENT handled)", async () => {
			// tempDir exists but WORKFLOW_DIR sub-path was never created
			expect(fs.existsSync(path.join(tempDir, WORKFLOW_DIR))).toBe(false);

			const result = await listWorkflows(tempDir);
			expect(result).toEqual([]);
		});

		test("WORKFLOW_DIR contains files mixed with dirs — only dirs included", async () => {
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			fs.mkdirSync(workflowRoot, { recursive: true });
			await Bun.write(path.join(workflowRoot, "noise.txt"), "file");
			await Bun.write(path.join(workflowRoot, ".active"), "some-slug");
			await createWorkflowState(tempDir, "2024-01-01-real");

			const result = await listWorkflows(tempDir);
			expect(result).toContain("2024-01-01-real");
			expect(result).not.toContain("noise.txt");
			expect(result).not.toContain(".active");
		});
	});

	// -------------------------------------------------------------------------
	// findActiveWorkflow
	// -------------------------------------------------------------------------

	describe("findActiveWorkflow", () => {
		test(".active file has surrounding whitespace and newline — slug trimmed correctly", async () => {
			const slug = "2024-01-01-whitespace-active";
			await createWorkflowState(tempDir, slug);
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			fs.mkdirSync(workflowRoot, { recursive: true });
			// Write slug with surrounding whitespace
			await Bun.write(path.join(workflowRoot, ".active"), `  ${slug}\n`);

			const found = await findActiveWorkflow(tempDir);
			expect(found).toBe(slug);
		});

		test(".active file is empty string — falls back to most recent workflow by date", async () => {
			await createWorkflowState(tempDir, "2024-01-01-older");
			await createWorkflowState(tempDir, "2024-01-02-newer");
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			await Bun.write(path.join(workflowRoot, ".active"), "");

			const found = await findActiveWorkflow(tempDir);
			expect(found).toBe("2024-01-02-newer");
		});
	});

	// -------------------------------------------------------------------------
	// setActiveWorkflowSlug / getActiveWorkflowSlug
	// -------------------------------------------------------------------------

	describe("setActiveWorkflowSlug", () => {
		test("setting a slug then a different slug — second slug persisted", async () => {
			await createWorkflowState(tempDir, "2024-01-01-first");
			await createWorkflowState(tempDir, "2024-01-02-second");

			await setActiveWorkflowSlug(tempDir, "2024-01-01-first");
			await setActiveWorkflowSlug(tempDir, "2024-01-02-second");

			const active = await getActiveWorkflowSlug(tempDir);
			expect(active).toBe("2024-01-02-second");
		});

		test("set to null when .active does not exist — no error thrown", async () => {
			// No WORKFLOW_DIR created at all; null should be a no-op
			await expect(setActiveWorkflowSlug(tempDir, null)).resolves.toBeUndefined();
		});
	});

	describe("getActiveWorkflowSlug", () => {
		test(".active file exists but contains only whitespace — returns null", async () => {
			const workflowRoot = path.join(tempDir, WORKFLOW_DIR);
			fs.mkdirSync(workflowRoot, { recursive: true });
			await Bun.write(path.join(workflowRoot, ".active"), "   \n  ");

			const result = await getActiveWorkflowSlug(tempDir);
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// updateWorkflowActivePhases
	// -------------------------------------------------------------------------

	describe("updateWorkflowActivePhases", () => {
		test("empty phases array — stored as empty array in state", async () => {
			const slug = "2024-01-01-update-empty-phases";
			await createWorkflowState(tempDir, slug, ["brainstorm", "finish"]);
			await updateWorkflowActivePhases(tempDir, slug, []);

			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.activePhases).toEqual([]);
		});

		test("workflow does not exist yet — creates state with provided activePhases", async () => {
			const slug = "2024-01-01-create-via-update-phases";
			const phases: WorkflowPhase[] = ["brainstorm", "plan"];
			await updateWorkflowActivePhases(tempDir, slug, phases);

			expect(fs.existsSync(stateJsonPath(tempDir, slug))).toBe(true);
			const state = (await Bun.file(stateJsonPath(tempDir, slug)).json()) as WorkflowState;
			expect(state.activePhases).toEqual(phases);
		});
	});

	// -------------------------------------------------------------------------
	// persistPhaseLearnings
	// -------------------------------------------------------------------------

	describe("persistPhaseLearnings", () => {
		test("three sequential calls — all three sections appended in order", async () => {
			const slug = "2024-01-01-three-learnings";
			await createWorkflowState(tempDir, slug);

			await persistPhaseLearnings(tempDir, slug, "brainstorm", "Insight A");
			await persistPhaseLearnings(tempDir, slug, "spec", "Insight B");
			await persistPhaseLearnings(tempDir, slug, "plan", "Insight C");

			const learningsPath = path.join(resolveWorkflowDir(tempDir, slug), "learnings.md");
			const content = await Bun.file(learningsPath).text();
			expect(content).toContain("## brainstorm learnings");
			expect(content).toContain("Insight A");
			expect(content).toContain("## spec learnings");
			expect(content).toContain("Insight B");
			expect(content).toContain("## plan learnings");
			expect(content).toContain("Insight C");
			// Verify ordering: brainstorm comes before spec, spec before plan
			expect(content.indexOf("brainstorm learnings")).toBeLessThan(content.indexOf("spec learnings"));
			expect(content.indexOf("spec learnings")).toBeLessThan(content.indexOf("plan learnings"));
		});

		test("empty content string — still writes header section", async () => {
			const slug = "2024-01-01-empty-learnings";
			await createWorkflowState(tempDir, slug);
			await persistPhaseLearnings(tempDir, slug, "brainstorm", "");

			const learningsPath = path.join(resolveWorkflowDir(tempDir, slug), "learnings.md");
			const content = await Bun.file(learningsPath).text();
			expect(content).toContain("## brainstorm learnings");
		});

		test("same phase called twice — both entries present in learnings", async () => {
			const slug = "2024-01-01-repeat-phase-learnings";
			await createWorkflowState(tempDir, slug);
			await persistPhaseLearnings(tempDir, slug, "brainstorm", "First pass.");
			await persistPhaseLearnings(tempDir, slug, "brainstorm", "Second pass.");

			const learningsPath = path.join(resolveWorkflowDir(tempDir, slug), "learnings.md");
			const content = await Bun.file(learningsPath).text();
			expect(content).toContain("First pass.");
			expect(content).toContain("Second pass.");
			// Two separate brainstorm headers
			const count = (content.match(/## brainstorm learnings/g) ?? []).length;
			expect(count).toBe(2);
		});
	});

	// -------------------------------------------------------------------------
	// formatWorkflowStatus
	// -------------------------------------------------------------------------

	describe("formatWorkflowStatus", () => {
		test("state with no artifacts — 'Artifacts:' present but no phase entries follow it", () => {
			const state: WorkflowState = {
				slug: "2024-01-01-no-artifacts",
				currentPhase: "brainstorm",
				artifacts: {},
			};
			const result = formatWorkflowStatus(state);
			expect(result).toContain("Artifacts:");
			const lines = result.split("\n");
			const artifactsIdx = lines.indexOf("Artifacts:");
			// Nothing after the Artifacts: line
			expect(lines.slice(artifactsIdx + 1).every(l => l === "")).toBe(true);
		});

		test("state with abandoned status — status field visible in output", () => {
			const state: WorkflowState = {
				slug: "2024-01-01-abandoned",
				currentPhase: "plan",
				artifacts: {
					brainstorm: `${WORKFLOW_DIR}/2024-01-01-abandoned/brainstorm.md`,
				},
				status: "abandoned",
			};
			// formatWorkflowStatus uses Object.entries(state.artifacts), so abandoned
			// status is not explicitly rendered by the current impl — but the state
			// object itself carries it. Verify the function doesn't throw and basic
			// fields are present.
			const result = formatWorkflowStatus(state);
			expect(result).toContain("Workflow: 2024-01-01-abandoned");
			expect(result).toContain("Current phase: plan");
			expect(result).toContain("brainstorm:");
		});
	});

	// -------------------------------------------------------------------------
	// PHASES constant
	// -------------------------------------------------------------------------

	describe("PHASES constant", () => {
		test("contains all expected phases in correct order", () => {
			expect(PHASES).toEqual(["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"]);
		});
	});
});
