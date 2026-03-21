import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const WORKFLOW_DIR = "docs/workflow";

export interface WorkflowState {
	slug: string;
	currentPhase: string;
	artifacts: Record<string, string>;
}

const PHASES = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"] as const;
export type WorkflowPhase = (typeof PHASES)[number];

/** Resolve the workflow directory for a given slug */
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
export async function writeWorkflowArtifact(cwd: string, slug: string, phase: string, content: string): Promise<void> {
	const dir = resolveWorkflowDir(cwd, slug);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `${phase}.md`), content);

	// Update state
	const state = (await readWorkflowState(cwd, slug)) ?? {
		slug,
		currentPhase: phase,
		artifacts: {},
	};
	state.currentPhase = phase;
	state.artifacts[phase] = path.join(WORKFLOW_DIR, slug, `${phase}.md`);
	await Bun.write(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
}

/** Read the workflow state file */
export async function readWorkflowState(cwd: string, slug: string): Promise<WorkflowState | null> {
	try {
		return await Bun.file(path.join(resolveWorkflowDir(cwd, slug), "state.json")).json();
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
