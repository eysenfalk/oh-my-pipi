import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export const WORKFLOW_DIR = "docs/workflow";

const ACTIVE_FILE = ".active";

export interface WorkflowState {
	slug: string;
	currentPhase: WorkflowPhase;
	artifacts: Partial<Record<WorkflowPhase, string>>;
	activePhases?: WorkflowPhase[];
	status?: "active" | "abandoned";
}

export const PHASES = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"] as const;
export type WorkflowPhase = (typeof PHASES)[number];

export function resolveWorkflowDir(cwd: string, slug: string): string {
	return path.join(cwd, WORKFLOW_DIR, slug);
}

/** Read a workflow artifact by phase name */
export async function readWorkflowArtifact(cwd: string, slug: string, phase: string): Promise<string | null> {
	try {
		return await Bun.file(path.join(resolveWorkflowDir(cwd, slug), `${phase}.md`)).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Write a workflow artifact and update state */
export async function writeWorkflowArtifact(
	cwd: string,
	slug: string,
	phase: WorkflowPhase,
	content: string,
	activePhases?: WorkflowPhase[],
): Promise<void> {
	const dir = resolveWorkflowDir(cwd, slug);
	await fs.mkdir(dir, { recursive: true });

	// Write state first — worst case on crash: state references phase with no artifact file,
	// which readWorkflowArtifact handles by returning null.
	const state = (await readWorkflowState(cwd, slug)) ?? {
		slug,
		currentPhase: phase,
		artifacts: {} as Partial<Record<WorkflowPhase, string>>,
	};
	state.currentPhase = phase;
	state.artifacts[phase] = path.join(WORKFLOW_DIR, slug, `${phase}.md`);
	if (activePhases !== undefined) {
		state.activePhases = activePhases;
	}
	await Bun.write(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
	await Bun.write(path.join(dir, `${phase}.md`), content);
}

/** Update only the activePhases field in workflow state */
export async function updateWorkflowActivePhases(cwd: string, slug: string, phases: WorkflowPhase[]): Promise<void> {
	const dir = resolveWorkflowDir(cwd, slug);
	await fs.mkdir(dir, { recursive: true });
	const state = (await readWorkflowState(cwd, slug)) ?? {
		slug,
		currentPhase: "brainstorm",
		artifacts: {},
	};
	state.activePhases = phases;
	await Bun.write(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
}

/** Read the workflow state file */
export async function readWorkflowState(cwd: string, slug: string): Promise<WorkflowState | null> {
	try {
		const state = (await Bun.file(path.join(resolveWorkflowDir(cwd, slug), "state.json")).json()) as WorkflowState;
		if (!PHASES.includes(state.currentPhase as WorkflowPhase)) {
			logger.warn("Invalid currentPhase in workflow state, defaulting to brainstorm", {
				slug,
				currentPhase: state.currentPhase,
			});
			state.currentPhase = "brainstorm";
		}
		return state;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** List all workflow directories (sorted by recency) */
export async function listWorkflows(cwd: string): Promise<string[]> {
	const workflowRoot = path.join(cwd, WORKFLOW_DIR);
	try {
		const entries = await fs.readdir(workflowRoot, { withFileTypes: true });
		return entries
			.filter(e => e.isDirectory())
			.map(e => e.name)
			.sort()
			.reverse(); // Most recent first (date-prefixed slugs)
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

/** Find the most recent workflow slug that has a state.json */
export async function findActiveWorkflow(cwd: string): Promise<string | null> {
	const active = await getActiveWorkflowSlug(cwd);
	if (active) {
		const state = await readWorkflowState(cwd, active);
		if (state) return active;
	}
	// Fallback: most recent by date
	const slugs = await listWorkflows(cwd);
	for (const slug of slugs) {
		const state = await readWorkflowState(cwd, slug);
		if (state) return slug;
	}
	return null;
}

/** Generate a slug from a topic string */
export function generateSlug(topic: string): string {
	const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const sanitized = topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	return sanitized ? `${date}-${sanitized}` : date;
}

/** Format workflow status for display */
export function formatWorkflowStatus(state: WorkflowState): string {
	const lines = [`Workflow: ${state.slug}`, `Current phase: ${state.currentPhase}`, "Artifacts:"];
	for (const [phase, artifactPath] of Object.entries(state.artifacts)) {
		lines.push(`  ${phase}: ${artifactPath}`);
	}
	return lines.join("\n");
}

/** Append phase learnings to the cumulative learnings file */
export async function persistPhaseLearnings(cwd: string, slug: string, phase: string, content: string): Promise<void> {
	const dir = resolveWorkflowDir(cwd, slug);
	const learningsPath = path.join(dir, "learnings.md");
	const header = `\n\n## ${phase} learnings\n\n`;

	try {
		const existing = await Bun.file(learningsPath).text();
		await Bun.write(learningsPath, existing + header + content);
	} catch (err) {
		if (isEnoent(err)) {
			await Bun.write(learningsPath, `# Workflow Learnings\n${header}${content}`);
		} else {
			throw err;
		}
	}
}

/** Create initial workflow state */
export async function createWorkflowState(cwd: string, slug: string, activePhases?: WorkflowPhase[]): Promise<void> {
	const dir = resolveWorkflowDir(cwd, slug);
	await fs.mkdir(dir, { recursive: true });
	const initial: WorkflowState = { slug, currentPhase: "brainstorm", artifacts: {} };
	if (activePhases) initial.activePhases = activePhases;
	await Bun.write(path.join(dir, "state.json"), JSON.stringify(initial, null, 2));
}

/** Read the active workflow slug from the .active file */
export async function getActiveWorkflowSlug(cwd: string): Promise<string | null> {
	try {
		const text = (await Bun.file(path.join(cwd, WORKFLOW_DIR, ACTIVE_FILE)).text()).trim();
		return text || null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** Write or clear the active workflow slug in the .active file */
export async function setActiveWorkflowSlug(cwd: string, slug: string | null): Promise<void> {
	const filePath = path.join(cwd, WORKFLOW_DIR, ACTIVE_FILE);
	if (slug === null) {
		try {
			await fs.unlink(filePath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	} else {
		await Bun.write(filePath, slug);
	}
}

/** Get the next phase in the workflow sequence, respecting activePhases filter */
export function getNextPhase(state: WorkflowState): WorkflowPhase | null {
	const currentIdx = PHASES.indexOf(state.currentPhase);
	if (currentIdx === -1) return null;
	for (let i = currentIdx + 1; i < PHASES.length; i++) {
		const phase = PHASES[i];
		if (state.activePhases) {
			if (state.activePhases.includes(phase)) return phase;
		} else {
			return phase; // No activePhases filter = all enabled
		}
	}
	return null;
}
