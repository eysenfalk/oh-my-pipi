import { logger } from "@oh-my-pi/pi-utils";
import { type SettingPath, settings } from "../../../../config/settings";
import type { WorkflowPhase } from "./artifacts";

export type ApprovalMode = "none" | "user" | "agent" | "both";
export type ReviewAgent = "critic" | "reviewer";

/** Minimal context needed by the approval gate */
export interface ApprovalContext {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export type ApprovalResult =
	| { approved: true; reviewPrompt?: undefined }
	| { approved: false; reason?: string; reviewPrompt?: undefined }
	| { approved: false; reviewPrompt: string };

export async function runApprovalGate(phase: WorkflowPhase, ctx: ApprovalContext): Promise<ApprovalResult> {
	const approvalMode = settings.get(`workflow.phases.${phase}.approval` as SettingPath) as ApprovalMode;
	const reviewAgent = settings.get(`workflow.phases.${phase}.reviewAgent` as SettingPath) as ReviewAgent;
	const maxRoundsStr = settings.get(`workflow.phases.${phase}.maxReviewRounds` as SettingPath) as string;
	const maxRounds = parseMaxRounds(maxRoundsStr);

	switch (approvalMode) {
		case "none":
			return { approved: true };

		case "user":
			return runUserApproval(phase, ctx);

		case "agent": {
			const reviewPrompt = buildReviewPrompt(phase, reviewAgent, maxRounds);
			return { approved: false, reviewPrompt };
		}

		case "both": {
			const reviewPrompt = buildAgentThenUserPrompt(phase, reviewAgent, maxRounds);
			return { approved: false, reviewPrompt };
		}

		default:
			logger.warn("Unknown approval mode, defaulting to user approval", { approvalMode });
			return runUserApproval(phase, ctx);
	}
}

export async function runUserApproval(phase: WorkflowPhase, ctx: ApprovalContext): Promise<ApprovalResult> {
	const choice = await ctx.select(`${capitalize(phase)} phase complete — review and approve`, [
		"Approve",
		"Refine",
		"Reject",
	]);
	if (choice === "Approve") return { approved: true };
	if (choice === "Refine") {
		const reason = await ctx.input("What needs refinement?");
		return {
			approved: false,
			reason: reason ?? "Refinement requested",
		};
	}
	if (choice === "Reject") {
		const rejectAction = await ctx.select("Rejected — what next?", ["Retry phase", "Abandon phase"]);
		if (rejectAction === "Retry phase") {
			return { approved: false, reason: "Rejected. Please retry this phase from scratch." };
		}
		return { approved: false, reason: rejectAction === "Abandon phase" ? "Phase abandoned." : undefined };
	}
	// undefined (cancelled via Escape)
	return { approved: false };
}

function buildReviewPrompt(phase: WorkflowPhase, reviewAgent: ReviewAgent, maxRounds: number): string {
	return [
		`The ${phase} phase output is ready for review. Your task:`,
		``,
		`Use the Task tool to dispatch a \`${reviewAgent}\` agent to review the phase output at \`local://${phase.toUpperCase()}.md\`.`,
		`The reviewer should assess quality, completeness, and correctness.`,
		`If the reviewer approves, call \`exit_plan_mode\` with the phase title.`,
		`If the reviewer rejects, refine the output and call \`exit_plan_mode\` again when ready.`,
		`When the review is complete (approved or rejected), call \`exit_plan_mode\` with \`reviewCompleted: true\` to proceed.`,
		`Maximum ${maxRounds} review iteration${maxRounds === 1 ? "" : "s"} before escalating to the user.`,
	].join("\n");
}

function buildAgentThenUserPrompt(phase: WorkflowPhase, reviewAgent: ReviewAgent, maxRounds: number): string {
	return [
		buildReviewPrompt(phase, reviewAgent, maxRounds),
		``,
		`After the agent review, the user will also be asked to approve before proceeding.`,
	].join("\n");
}

export function parseMaxRounds(value: string): number {
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) || parsed < 1 ? 3 : parsed;
}

function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
