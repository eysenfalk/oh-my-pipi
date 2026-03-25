/**
 * Test harness for workflow E2E tests.
 *
 * Provides a mock HookCommandContext and assertion helpers
 * for testing WorkflowCommand without LLM calls.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	readWorkflowArtifact,
	readWorkflowState,
	resolveWorkflowDir,
	WORKFLOW_DIR,
	type WorkflowPhase,
	type WorkflowState,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";

// ---------------------------------------------------------------------------
// Mock UI
// ---------------------------------------------------------------------------

export interface UICall {
	method: "select" | "confirm" | "input" | "notify" | "setStatus" | "setEditorText" | "custom";
	args: unknown[];
}

export class MockHookUI {
	calls: UICall[] = [];
	#selectResponses: (string | undefined)[] = [];
	#confirmResponses: boolean[] = [];
	#inputResponses: (string | undefined)[] = [];

	/** Queue a response for the next `select()` call. */
	queueSelect(response: string | undefined): void {
		this.#selectResponses.push(response);
	}

	/** Queue a response for the next `confirm()` call. */
	queueConfirm(response: boolean): void {
		this.#confirmResponses.push(response);
	}

	/** Queue a response for the next `input()` call. */
	queueInput(response: string | undefined): void {
		this.#inputResponses.push(response);
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.calls.push({ method: "select", args: [title, options] });
		if (this.#selectResponses.length === 0) {
			throw new Error(
				`showHookSelector called with no queued response. Title: ${title}, Options: ${JSON.stringify(options)}. Call ui.queueSelect() before the operation.`,
			);
		}
		return this.#selectResponses.shift();
	}

	async confirm(title: string, message: string): Promise<boolean> {
		this.calls.push({ method: "confirm", args: [title, message] });
		if (this.#confirmResponses.length === 0) {
			throw new Error(
				`showHookConfirm called with no queued response. Title: ${title}, Message: ${message}. Call ui.queueConfirm() before the operation.`,
			);
		}
		return this.#confirmResponses.shift() as boolean;
	}

	async input(title: string, placeholder?: string): Promise<string | undefined> {
		this.calls.push({ method: "input", args: [title, placeholder] });
		if (this.#inputResponses.length === 0) {
			throw new Error(
				`showHookInput called with no queued response. Title: ${title}, Placeholder: ${placeholder}. Call ui.queueInput() before the operation.`,
			);
		}
		return this.#inputResponses.shift();
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.calls.push({ method: "notify", args: [message, type] });
	}

	setStatus(key: string, text: string | undefined): void {
		this.calls.push({ method: "setStatus", args: [key, text] });
	}

	async custom<T>(): Promise<T> {
		this.calls.push({ method: "custom", args: [] });
		return undefined as T;
	}

	setEditorText(text: string): void {
		this.calls.push({ method: "setEditorText", args: [text] });
	}

	getEditorText(): string {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Mock HookCommandContext
// ---------------------------------------------------------------------------

export interface WorkflowAction {
	type: "startWorkflow" | "activateWorkflowPhase" | "switchWorkflow" | "newSession" | "branch" | "navigateTree";
	args: unknown[];
}

export class MockHookCommandContext {
	ui: MockHookUI;
	hasUI = true;
	cwd: string;
	sessionManager = {} as HookCommandContext["sessionManager"];
	modelRegistry = {} as HookCommandContext["modelRegistry"];
	model: Model | undefined = undefined;
	actions: WorkflowAction[] = [];

	constructor(cwd: string) {
		this.cwd = cwd;
		this.ui = new MockHookUI();
	}

	isIdle(): boolean {
		return true;
	}

	abort(): void {
		// noop
	}

	hasQueuedMessages(): boolean {
		return false;
	}

	async waitForIdle(): Promise<void> {
		// noop
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		this.actions.push({ type: "newSession", args: [] });
		return { cancelled: false };
	}

	async branch(entryId: string): Promise<{ cancelled: boolean }> {
		this.actions.push({ type: "branch", args: [entryId] });
		return { cancelled: false };
	}

	async navigateTree(targetId: string): Promise<{ cancelled: boolean }> {
		this.actions.push({ type: "navigateTree", args: [targetId] });
		return { cancelled: false };
	}

	async startWorkflow(details: { topic: string; slug?: string }): Promise<void> {
		this.actions.push({ type: "startWorkflow", args: [details] });
	}

	activateWorkflowPhase(slug: string, phase: WorkflowPhase, phases?: WorkflowPhase[] | null): void {
		this.actions.push({ type: "activateWorkflowPhase", args: [slug, phase, phases] });
	}

	async switchWorkflow(details: { slug: string; confirm?: boolean }): Promise<void> {
		this.actions.push({ type: "switchWorkflow", args: [details] });
	}
}

// ---------------------------------------------------------------------------
// Assertion Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a workflow state file exists and matches expected shape.
 */
export async function assertWorkflowState(
	cwd: string,
	slug: string,
	expected: Partial<WorkflowState>,
): Promise<WorkflowState> {
	const state = await readWorkflowState(cwd, slug);
	if (!state) {
		throw new Error(`Expected workflow state for slug "${slug}" but state.json does not exist`);
	}
	if (expected.slug !== undefined && state.slug !== expected.slug) {
		throw new Error(`Expected slug "${expected.slug}" but got "${state.slug}"`);
	}
	if (expected.currentPhase !== undefined && state.currentPhase !== expected.currentPhase) {
		throw new Error(`Expected currentPhase "${expected.currentPhase}" but got "${state.currentPhase}"`);
	}
	if (expected.artifacts) {
		for (const [phase, artifactPath] of Object.entries(expected.artifacts)) {
			if (state.artifacts[phase as WorkflowPhase] !== artifactPath) {
				throw new Error(
					`Expected artifact for phase "${phase}" to be "${artifactPath}" but got "${state.artifacts[phase as WorkflowPhase]}"`,
				);
			}
		}
	}
	if (expected.activePhases) {
		if (!state.activePhases) {
			throw new Error("Expected activePhases to be set but it is undefined");
		}
		const statePhases = [...state.activePhases].sort();
		const expectedPhases = [...expected.activePhases].sort();
		if (JSON.stringify(statePhases) !== JSON.stringify(expectedPhases)) {
			throw new Error(
				`Expected activePhases ${JSON.stringify(expectedPhases)} but got ${JSON.stringify(statePhases)}`,
			);
		}
	}
	if (expected.status !== undefined && state.status !== expected.status) {
		throw new Error(`Expected status "${expected.status}" but got "${state.status}"`);
	}
	return state;
}

/**
 * Assert that a phase artifact file exists and optionally contains expected content.
 */
export async function assertArtifactExists(
	cwd: string,
	slug: string,
	phase: WorkflowPhase,
	expectedContent?: string,
): Promise<string> {
	const content = await readWorkflowArtifact(cwd, slug, phase);
	if (content === null) {
		throw new Error(`Expected artifact for phase "${phase}" of workflow "${slug}" but file does not exist`);
	}
	if (expectedContent !== undefined && content !== expectedContent) {
		throw new Error(`Artifact content mismatch for ${phase}. Expected:\n${expectedContent}\nGot:\n${content}`);
	}
	return content;
}

/**
 * Assert that a phase artifact file does NOT exist.
 */
export async function assertArtifactMissing(cwd: string, slug: string, phase: WorkflowPhase): Promise<void> {
	const content = await readWorkflowArtifact(cwd, slug, phase);
	if (content !== null) {
		throw new Error(`Expected no artifact for phase "${phase}" of workflow "${slug}" but file exists`);
	}
}

/**
 * Assert that the .active file points to the given slug (or null for no active).
 */
export async function assertActiveWorkflow(cwd: string, expected: string | null): Promise<void> {
	const activePath = path.join(cwd, WORKFLOW_DIR, ".active");
	try {
		const content = await Bun.file(activePath).text();
		const slug = content.trim() || null;
		if (slug !== expected) {
			throw new Error(`Expected active workflow "${expected}" but got "${slug}"`);
		}
	} catch (_err) {
		if (expected !== null) {
			throw new Error(`Expected active workflow "${expected}" but .active file does not exist`);
		}
		// null expected and file doesn't exist — ok
	}
}

/**
 * Assert that specified files exist in the workflow directory.
 */
export function assertWorkflowDirContains(cwd: string, slug: string, files: string[]): void {
	const dir = resolveWorkflowDir(cwd, slug);
	for (const file of files) {
		const filePath = path.join(dir, file);
		if (!fs.existsSync(filePath)) {
			throw new Error(`Expected file "${file}" in workflow dir for "${slug}" but it does not exist`);
		}
	}
}

/**
 * Create a temp directory for a test.
 */
export function createTempDir(): string {
	const tempDir = path.join(os.tmpdir(), `omp-e2e-test-${crypto.randomUUID()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

/**
 * Remove a temp directory.
 */
export function removeTempDir(tempDir: string): void {
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Get all notify calls from the mock UI.
 */
export function getNotifications(ctx: MockHookCommandContext): Array<{ message: string; type?: string }> {
	return ctx.ui.calls
		.filter(c => c.method === "notify")
		.map(c => ({ message: c.args[0] as string, type: c.args[1] as string | undefined }));
}

/**
 * Get all setEditorText calls from the mock UI.
 */
export function getEditorTexts(ctx: MockHookCommandContext): string[] {
	return ctx.ui.calls.filter(c => c.method === "setEditorText").map(c => c.args[0] as string);
}

/**
 * Get actions of a specific type from the mock context.
 */
export function getActions(ctx: MockHookCommandContext, type: WorkflowAction["type"]): WorkflowAction[] {
	return ctx.actions.filter(a => a.type === type);
}
