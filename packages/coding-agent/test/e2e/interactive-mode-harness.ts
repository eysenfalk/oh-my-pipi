/**
 * InteractiveMode integration test harness.
 *
 * Creates a real InteractiveMode with VirtualTerminal but patches the UI
 * methods (showHookSelector, showHookInput) to return queued responses.
 * Captures onInputCallback calls and editor.setText calls.
 *
 * This tests the ORCHESTRATION layer: handleExitPlanModeTool ->
 * #handleWorkflowPhaseComplete -> approval gate -> #handleApprovalResult ->
 * writeWorkflowArtifact -> "Continue to next?" flow.
 */

import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	readWorkflowArtifact,
	readWorkflowState,
	type WorkflowPhase,
	type WorkflowState,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/artifacts";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ExitPlanModeDetails } from "@oh-my-pi/pi-coding-agent/tools";
import { VirtualTerminal } from "@oh-my-pi/pi-tui/test/virtual-terminal";
import { Snowflake } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Mock LLM stream (never generates anything — we test orchestration, not LLM)
// ---------------------------------------------------------------------------
class MockAssistantStream extends AssistantMessageEventStream {}

// ---------------------------------------------------------------------------
// Captured state
// ---------------------------------------------------------------------------

export interface CapturedSubmission {
	text: string;
}

export interface HarnessCaptures {
	/** onInputCallback submissions (refinement, review prompts). */
	submissions: CapturedSubmission[];
	/** editor.setText() calls (next phase commands). */
	editorTexts: string[];
	/** showStatus() messages. */
	statuses: string[];
	/** showError() messages. */
	errors: string[];
	/** showWarning() messages. */
	warnings: string[];
	/** showHookSelector calls (title + options). */
	selectorCalls: { title: string; options: string[] }[];
	/** showHookInput calls (title + placeholder). */
	inputCalls: { title: string; placeholder?: string }[];
}

// ---------------------------------------------------------------------------
// Queued UI responses
// ---------------------------------------------------------------------------

interface QueuedSelector {
	response: string | undefined;
}

interface QueuedInput {
	response: string | undefined;
}

// ---------------------------------------------------------------------------
// InteractiveMode Harness
// ---------------------------------------------------------------------------

export class InteractiveModeHarness {
	mode!: InteractiveMode;
	session!: AgentSession;
	terminal!: VirtualTerminal;
	sessionManager!: SessionManager;
	captures: HarnessCaptures = {
		submissions: [],
		editorTexts: [],
		statuses: [],
		errors: [],
		warnings: [],
		selectorCalls: [],
		inputCalls: [],
	};

	readonly tempDir: string;
	readonly cwd: string;
	#selectorQueue: QueuedSelector[] = [];
	#inputQueue: QueuedInput[] = [];
	#authStorage?: AuthStorage;
	#localRoot?: string;
	#disposed = false;

	constructor() {
		this.tempDir = path.join(os.tmpdir(), `omp-im-test-${Snowflake.next()}`);
		this.cwd = path.join(this.tempDir, "project");
		fs.mkdirSync(this.cwd, { recursive: true });
	}

	/**
	 * Initialize the harness. Must be called before use.
	 * Separate from constructor because it's async.
	 */
	async init(settingsOverrides?: Record<string, unknown>): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		// Minimal agent that never produces output
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				// Never emits done — we don't need the agent to run
				return stream;
			},
		});

		this.sessionManager = SessionManager.inMemory(this.cwd);

		// Settings: reset global singleton and init in-memory
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: settingsOverrides ?? {} });
		const settings = Settings.isolated(settingsOverrides);

		this.#authStorage = await AuthStorage.create(path.join(this.tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(this.#authStorage, path.join(this.tempDir, "models.yml"));
		this.#authStorage.setRuntimeApiKey("anthropic", "test-key");

		this.session = new AgentSession({
			agent,
			sessionManager: this.sessionManager,
			settings,
			modelRegistry,
		});

		this.terminal = new VirtualTerminal(120, 40);

		// Theme must be initialized before constructing InteractiveMode (getEditorTheme() needs it)
		await initTheme();

		// Create InteractiveMode with VirtualTerminal (no init() — skip heavy side effects)
		this.mode = new InteractiveMode(
			this.session,
			"0.0.0-test",
			undefined,
			() => {},
			undefined,
			undefined,
			this.terminal,
		);

		// Compute local root for plan file writes
		this.#localRoot = resolveLocalRoot({
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});

		// Monkey-patch UI methods to use queued responses
		this.#patchShowHookSelector();
		this.#patchShowHookInput();
		this.#patchShowStatus();
		this.#patchShowError();
		this.#patchShowWarning();
		this.#patchOnInputCallback();
		this.#patchEditorSetText();
		this.#patchSessionAbort();
	}

	// -----------------------------------------------------------------------
	// Queue UI responses
	// -----------------------------------------------------------------------

	/** Queue a response for the next showHookSelector call. */
	queueSelectorResponse(response: string | undefined): void {
		this.#selectorQueue.push({ response });
	}

	/** Queue a response for the next showHookInput call. */
	queueInputResponse(response: string | undefined): void {
		this.#inputQueue.push({ response });
	}

	// -----------------------------------------------------------------------
	// Plan file management
	// -----------------------------------------------------------------------

	/** Write a plan file at the local:// path the orchestration expects. */
	async writePlanFile(filename: string, content: string): Promise<void> {
		const filePath = path.join(this.#localRoot!, filename);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, content);
	}

	/** Get the resolved path for a local:// URL. */
	getLocalPath(filename: string): string {
		return path.join(this.#localRoot!, filename);
	}

	// -----------------------------------------------------------------------
	// Call orchestration methods directly
	// -----------------------------------------------------------------------

	/** Call handleExitPlanModeTool with the given details. */
	async handleExitPlanModeTool(details: ExitPlanModeDetails): Promise<void> {
		return this.mode.handleExitPlanModeTool(details);
	}

	/** Call handleStartWorkflowTool. */
	async handleStartWorkflowTool(details: { topic: string; slug?: string }): Promise<void> {
		return this.mode.handleStartWorkflowTool(details);
	}

	/** Call handleSwitchWorkflowTool. */
	async handleSwitchWorkflowTool(details: { slug: string; confirm?: boolean }): Promise<void> {
		return this.mode.handleSwitchWorkflowTool(details);
	}

	/** Set proposed phases (simulates propose_phases tool). */
	setProposePhases(proposal: { phases: string[]; rationale: string }): void {
		this.mode.setProposePhases(proposal);
	}

	/** Set active workflow state (simulates prior phase completion). */
	setActiveWorkflow(slug: string | null, phase: string | null, phases: string[] | null): void {
		this.mode.setActiveWorkflow(slug, phase as WorkflowPhase, phases as WorkflowPhase[]);
	}

	// -----------------------------------------------------------------------
	// Assertions
	// -----------------------------------------------------------------------

	/** Assert workflow state matches expected values. */
	async assertWorkflowState(slug: string, expected: Partial<WorkflowState>): Promise<void> {
		const state = await readWorkflowState(this.cwd, slug);
		expect(state).not.toBeNull();
		if (expected.slug !== undefined) expect(state!.slug).toBe(expected.slug);
		if (expected.currentPhase !== undefined) expect(state!.currentPhase).toBe(expected.currentPhase);
		if (expected.artifacts !== undefined) {
			for (const [phase, _artifactPath] of Object.entries(expected.artifacts)) {
				expect(state!.artifacts[phase as WorkflowPhase]).toBeDefined();
			}
		}
		if (expected.activePhases !== undefined) {
			expect(state!.activePhases).toEqual(expected.activePhases);
		}
	}

	/** Assert a phase artifact file exists. */
	async assertArtifactExists(slug: string, phase: WorkflowPhase): Promise<void> {
		const content = await readWorkflowArtifact(this.cwd, slug, phase);
		expect(content).not.toBeNull();
	}

	/** Assert a phase artifact file does NOT exist. */
	async assertArtifactMissing(slug: string, phase: WorkflowPhase): Promise<void> {
		const content = await readWorkflowArtifact(this.cwd, slug, phase);
		expect(content).toBeNull();
	}

	/** Assert artifact content matches. */
	async assertArtifactContent(slug: string, phase: WorkflowPhase, expectedContent: string): Promise<void> {
		const content = await readWorkflowArtifact(this.cwd, slug, phase);
		expect(content).toBe(expectedContent);
	}

	// -----------------------------------------------------------------------
	// Reset captured state (for multi-step journeys)
	// -----------------------------------------------------------------------

	resetCaptures(): void {
		this.captures = {
			submissions: [],
			editorTexts: [],
			statuses: [],
			errors: [],
			warnings: [],
			selectorCalls: [],
			inputCalls: [],
		};
	}

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;

		// Remove resize listener added by InteractiveMode constructor
		process.stdout.removeAllListeners("resize");

		// Clean up settings global
		_resetSettingsForTest();

		// Close auth storage
		if (this.#authStorage) {
			this.#authStorage.close();
		}

		// Dispose session
		if (this.session) {
			try {
				await this.session.dispose();
			} catch {
				// Ignore disposal errors in tests
			}
		}

		// Remove temp files
		try {
			fs.rmSync(this.tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}

		// Clean local root temp files
		if (this.#localRoot) {
			try {
				fs.rmSync(this.#localRoot, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}
	}

	// -----------------------------------------------------------------------
	// Monkey patches
	// -----------------------------------------------------------------------

	#patchShowHookSelector(): void {
		this.mode.showHookSelector = async (title: string, options: string[]): Promise<string | undefined> => {
			this.captures.selectorCalls.push({ title, options });
			const queued = this.#selectorQueue.shift();
			if (!queued) {
				throw new Error(
					`showHookSelector called with no queued response.\n` +
						`  Title: ${title}\n` +
						`  Options: ${JSON.stringify(options)}\n` +
						`  Queue empty. Call harness.queueSelectorResponse() before the operation.`,
				);
			}
			return queued.response;
		};
	}

	#patchShowHookInput(): void {
		this.mode.showHookInput = async (title: string, placeholder?: string): Promise<string | undefined> => {
			this.captures.inputCalls.push({ title, placeholder });
			const queued = this.#inputQueue.shift();
			if (!queued) {
				throw new Error(
					`showHookInput called with no queued response.\n` +
						`  Title: ${title}\n` +
						`  Placeholder: ${placeholder}\n` +
						`  Queue empty. Call harness.queueInputResponse() before the operation.`,
				);
			}
			return queued.response;
		};
	}

	#patchShowStatus(): void {
		const _orig = this.mode.showStatus.bind(this.mode);
		this.mode.showStatus = (message: string, _options?: { dim?: boolean }) => {
			this.captures.statuses.push(message);
			// Don't call orig — it tries to render in TUI which may have setup issues
		};
	}

	#patchShowError(): void {
		this.mode.showError = (message: string) => {
			this.captures.errors.push(message);
		};
	}

	#patchShowWarning(): void {
		this.mode.showWarning = (message: string) => {
			this.captures.warnings.push(message);
		};
	}

	#patchOnInputCallback(): void {
		this.mode.onInputCallback = input => {
			this.captures.submissions.push({ text: input.text });
		};
	}

	#patchEditorSetText(): void {
		const editor = this.mode.editor;
		const _origSetText = editor.setText.bind(editor);
		editor.setText = (text: string) => {
			this.captures.editorTexts.push(text);
			// Don't call original — it manipulates internal editor state
		};
	}

	#patchSessionAbort(): void {
		// Make session.abort() a no-op in tests
		this.session.abort = async () => {};
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and initialize an InteractiveMode harness.
 * The harness must be disposed after use.
 */
export async function createInteractiveModeHarness(
	settingsOverrides?: Record<string, unknown>,
): Promise<InteractiveModeHarness> {
	const harness = new InteractiveModeHarness();
	await harness.init(settingsOverrides);
	return harness;
}
