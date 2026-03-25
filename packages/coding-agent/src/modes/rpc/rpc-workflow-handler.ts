/**
 * Workflow support for RPC mode.
 *
 * Handles the workflow phase completion flow that InteractiveMode handles via its
 * event controller. In RPC mode, approval gates use extension_ui_request/response,
 * and follow-up prompts are submitted via session.prompt().
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { renderPromptTemplate } from "../../config/prompt-templates";
import { settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import {
	type ApprovalContext,
	type ApprovalResult,
	parseMaxRounds,
	runApprovalGate,
	runUserApproval,
} from "../../extensibility/custom-commands/bundled/workflow/approval";
import type { WorkflowPhase } from "../../extensibility/custom-commands/bundled/workflow/artifacts";
import {
	createWorkflowState,
	generateSlug,
	getNextPhase,
	readWorkflowState,
	setActiveWorkflowSlug,
	WORKFLOW_DIR,
	writeWorkflowArtifact,
} from "../../extensibility/custom-commands/bundled/workflow/artifacts";
import brainstormPrompt from "../../extensibility/custom-commands/bundled/workflow/prompts/brainstorm-start.md" with {
	type: "text",
};
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { resolveLocalUrlToPath } from "../../internal-urls";
import type { AgentSession } from "../../session/agent-session";

interface ExitPlanModeDetails {
	planFilePath: string;
	planExists: boolean;
	title?: string;
	finalPlanFilePath?: string;
	workflowSlug?: string;
	workflowPhase?: string;
	reviewCompleted?: boolean;
}

/**
 * Handles workflow operations in RPC mode.
 *
 * Provides the three missing HookCommandContext methods (startWorkflow, activateWorkflowPhase,
 * switchWorkflow) and subscribes to agent events for phase completion.
 */
export class RpcWorkflowHandler {
	#session: AgentSession;
	#uiContext: ExtensionUIContext;
	#activeWorkflowSlug: string | null = null;
	#activeWorkflowPhase: string | null = null;
	#activeWorkflowPhases: WorkflowPhase[] | string[] | null = null;
	#proposedWorkflowPhases: { phases: string[]; rationale: string } | null = null;
	#reviewRoundCount = new Map<string, number>();

	/** Current workflow state for diagnostics and testing. */
	get activeWorkflow(): { slug: string | null; phase: string | null; phases: WorkflowPhase[] | string[] | null } {
		return { slug: this.#activeWorkflowSlug, phase: this.#activeWorkflowPhase, phases: this.#activeWorkflowPhases };
	}

	constructor(session: AgentSession, uiContext: ExtensionUIContext) {
		this.#session = session;
		this.#uiContext = uiContext;
	}

	/** Subscribe to agent events that need workflow handling. */
	subscribeToEvents(): void {
		this.#session.subscribe(async event => {
			if (event.type !== "tool_execution_end" || event.isError) return;

			const details = event.result?.details;
			if (!details) return;

			switch (event.toolName) {
				case "exit_plan_mode": {
					const d = details as ExitPlanModeDetails;
					const workflowSlug = d.workflowSlug || this.#activeWorkflowSlug;
					const workflowPhase = d.workflowPhase || this.#activeWorkflowPhase;
					if (workflowSlug && workflowPhase) {
						await this.#session.abort();
						await this.#handleWorkflowPhaseComplete(workflowSlug, workflowPhase as WorkflowPhase, d);
					}
					break;
				}
				case "propose_phases": {
					const d = details as { phases: string[]; rationale: string };
					this.#proposedWorkflowPhases = d;
					break;
				}
				case "start_workflow": {
					const d = details as { topic: string; slug?: string };
					await this.startWorkflow(d);
					break;
				}
				case "switch_workflow": {
					const d = details as { slug: string; confirm?: boolean };
					await this.switchWorkflow(d);
					break;
				}
			}
		});
	}

	// -- HookCommandContext methods --

	async startWorkflow(details: { topic: string; slug?: string }): Promise<void> {
		const cwd = this.#session.sessionManager.getCwd();
		const recommendedSlug = details.slug ?? generateSlug(details.topic);

		// Confirm or edit the slug name
		const confirmedSlug = await this.#uiContext.input("Workflow slug (confirm or edit)", recommendedSlug);
		if (!confirmedSlug) return;

		const slug = confirmedSlug.trim();
		if (!slug) return;

		// Collision detection
		const existing = await readWorkflowState(cwd, slug);
		if (existing) {
			const choice = await this.#uiContext.select(`Workflow "${slug}" already exists. Overwrite?`, [
				"Overwrite",
				"Cancel",
			]);
			if (choice !== "Overwrite") return;
		}

		// Persist initial state
		await createWorkflowState(cwd, slug);
		await setActiveWorkflowSlug(cwd, slug);

		const workflowDir = `${WORKFLOW_DIR}/${slug}`;

		await this.#session.abort();
		await this.#session.newSession({});

		this.#activeWorkflowSlug = slug;
		this.#activeWorkflowPhase = "brainstorm";
		this.#activeWorkflowPhases = null;

		const prompt = renderPromptTemplate(brainstormPrompt, {
			topic: details.topic,
			workflowDir,
			slug,
			workflowPhase: "brainstorm",
		});

		// In RPC mode, submit the prompt directly via session.prompt()
		this.#session.prompt(prompt).catch(() => {});
	}

	activateWorkflowPhase(slug: string, phase: WorkflowPhase, phases?: WorkflowPhase[] | null): void {
		this.#activeWorkflowSlug = slug;
		this.#activeWorkflowPhase = phase;
		this.#activeWorkflowPhases = phases ?? null;
		const cwd = this.#session.sessionManager.getCwd();
		void setActiveWorkflowSlug(cwd, slug);
	}

	async switchWorkflow(details: { slug: string; confirm?: boolean }): Promise<void> {
		const cwd = this.#session.sessionManager.getCwd();
		const state = await readWorkflowState(cwd, details.slug);
		if (!state) {
			this.#uiContext.notify(`No workflow state found for slug "${details.slug}".`, "error");
			return;
		}

		if (!details.confirm) {
			const choice = await this.#uiContext.select(`Switch to workflow "${details.slug}"?`, [
				"Yes, switch",
				"Cancel",
			]);
			if (choice !== "Yes, switch") return;
		}

		this.#activeWorkflowSlug = details.slug;
		this.#activeWorkflowPhase = state.currentPhase;
		this.#activeWorkflowPhases = state.activePhases ?? null;
		this.#uiContext.notify(`Switched to workflow: ${details.slug} (phase: ${state.currentPhase})`);
	}

	// -- Phase completion flow --

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local://")) {
			return resolveLocalUrlToPath(planFilePath, {
				getArtifactsDir: () => this.#session.sessionManager.getArtifactsDir(),
				getSessionId: () => this.#session.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.#session.sessionManager.getCwd(), planFilePath);
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async #handleWorkflowPhaseComplete(slug: string, phase: WorkflowPhase, details: ExitPlanModeDetails): Promise<void> {
		const phasePlanFilePath = details.planFilePath || `local://${phase.toUpperCase()}.md`;
		const content = await this.#readPlanFile(phasePlanFilePath);
		if (!content) {
			this.#uiContext.notify(
				`Phase output not found at ${phasePlanFilePath}. Write output there before calling exit_plan_mode.`,
				"error",
			);
			return;
		}

		// For brainstorm phase: show phase proposal confirmation before approval gate
		let approvedPhases: WorkflowPhase[] | undefined;
		if (phase === "brainstorm" && this.#proposedWorkflowPhases) {
			const proposal = this.#proposedWorkflowPhases;
			this.#proposedWorkflowPhases = null;

			const phaseList = proposal.phases.join(" → ");
			const choice = await this.#uiContext.select(`Proposed workflow phases: ${phaseList}`, [
				"Accept",
				"Edit phases",
				"Reject (use global settings)",
			]);

			if (choice === "Accept") {
				approvedPhases = proposal.phases as WorkflowPhase[];
			} else if (choice === "Edit phases") {
				const edited = await this.#uiContext.input("Edit phases (space or comma separated)", phaseList);
				if (edited) {
					approvedPhases = edited
						.split(/[\s,→]+/)
						.map(s => s.trim())
						.filter(Boolean) as WorkflowPhase[];
				}
			}
			// "Reject": approvedPhases stays undefined → global settings used
		}

		const approvalCtx: ApprovalContext = {
			select: (title, options) => this.#uiContext.select(title, options),
			input: (title, placeholder) => this.#uiContext.input(title, placeholder),
		};

		const roundKey = `${slug}/${phase}`;

		// If agent review is complete, go straight to user approval
		if (details.reviewCompleted) {
			const result = await runUserApproval(phase, approvalCtx);
			this.#reviewRoundCount.delete(roundKey);
			return this.#handleApprovalResult(slug, phase, phasePlanFilePath, content, approvedPhases, result, details);
		}

		const result = await runApprovalGate(phase, approvalCtx);

		if (result.reviewPrompt) {
			// Track review rounds to enforce max iterations
			const currentRound = (this.#reviewRoundCount.get(roundKey) ?? 0) + 1;
			const maxRoundsStr = settings.get(`workflow.phases.${phase}.maxReviewRounds` as SettingPath) as string;
			const maxRounds = parseMaxRounds(maxRoundsStr);

			if (currentRound >= maxRounds) {
				this.#uiContext.notify(
					`Maximum ${maxRounds} review round${maxRounds === 1 ? "" : "s"} reached. Escalating to user approval.`,
					"warning",
				);
				const escalated = await runUserApproval(phase, approvalCtx);
				this.#reviewRoundCount.delete(roundKey);
				return this.#handleApprovalResult(
					slug,
					phase,
					phasePlanFilePath,
					content,
					approvedPhases,
					escalated,
					details,
				);
			}

			this.#reviewRoundCount.set(roundKey, currentRound);
			// Submit review prompt as next agent input
			this.#session.prompt(result.reviewPrompt).catch(() => {});
			return;
		}

		// Non-review result (user approval or no-approval mode)
		this.#reviewRoundCount.delete(roundKey);
		return this.#handleApprovalResult(slug, phase, phasePlanFilePath, content, approvedPhases, result, details);
	}

	async #handleApprovalResult(
		slug: string,
		phase: WorkflowPhase,
		_phasePlanFilePath: string,
		content: string,
		approvedPhases: WorkflowPhase[] | undefined,
		result: ApprovalResult,
		_details: ExitPlanModeDetails,
	): Promise<void> {
		if (!result.approved) {
			const reason = "reason" in result ? result.reason : undefined;
			if (reason) {
				// Submit refinement as a message so the agent acts on it
				this.#session.prompt(reason).catch(() => {});
			}
			return;
		}

		// Approved: persist artifact
		const cwd = this.#session.sessionManager.getCwd();
		try {
			await writeWorkflowArtifact(cwd, slug, phase, content, approvedPhases);
			this.#uiContext.notify(`${phase} phase approved and saved to docs/workflow/${slug}/${phase}.md`);
		} catch (error) {
			this.#uiContext.notify(
				`Failed to persist ${phase} artifact: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}

		// Update active workflow tracking from saved state
		let nextPhase: WorkflowPhase | null = null;
		try {
			const updatedState = await readWorkflowState(cwd, slug);
			nextPhase = updatedState ? getNextPhase(updatedState) : null;
			this.#activeWorkflowSlug = slug;
			this.#activeWorkflowPhase = nextPhase ?? phase;
			this.#activeWorkflowPhases = updatedState?.activePhases ?? null;
		} catch {
			this.#activeWorkflowSlug = slug;
			this.#activeWorkflowPhase = phase;
			this.#activeWorkflowPhases = null;
		}

		// Offer to continue to next phase
		if (nextPhase) {
			const continueChoice = await this.#uiContext.select(`${phase} approved. Continue to ${nextPhase}?`, [
				"Continue",
				"Stop here",
			]);
			if (continueChoice === "Continue") {
				// In RPC mode, submit the next phase command as a prompt
				this.#session.prompt(`/workflow ${nextPhase} ${slug}`).catch(() => {});
			}
		}
	}
}
