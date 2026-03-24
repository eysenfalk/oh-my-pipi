import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import exitPlanModeDescription from "../prompts/tools/exit-plan-mode.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

const exitPlanModeSchema = Type.Object({
	title: Type.Optional(
		Type.String({ description: "Final plan title — required only for the last stage, e.g. WP_MIGRATION_PLAN" }),
	),
	workflowSlug: Type.Optional(Type.String({ description: "Active workflow slug (for workflow phases)" })),
	workflowPhase: Type.Optional(Type.String({ description: "Current workflow phase name (for workflow phases)" })),
	reviewCompleted: Type.Optional(
		Type.Boolean({
			description: "Set to true after agent review is complete. Signals the system to proceed to user approval.",
		}),
	),
});

type ExitPlanModeParams = Static<typeof exitPlanModeSchema>;

function normalizePlanTitle(title: string): { title: string; fileName: string } {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new ToolError("Title is required and must not be empty.");
	}

	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
		throw new ToolError("Title must not contain path separators or '..'.");
	}

	const withExtension = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
	if (!/^[A-Za-z0-9_-]+\.md$/.test(withExtension)) {
		throw new ToolError("Title may only contain letters, numbers, underscores, or hyphens.");
	}

	const normalizedTitle = withExtension.slice(0, -3);
	return { title: normalizedTitle, fileName: withExtension };
}

export interface ExitPlanModeDetails {
	planFilePath: string;
	planExists: boolean;
	title?: string;
	finalPlanFilePath?: string;
	workflowSlug?: string;
	workflowPhase?: string;
	reviewCompleted?: boolean;
}

export class ExitPlanModeTool implements AgentTool<typeof exitPlanModeSchema, ExitPlanModeDetails> {
	readonly name = "exit_plan_mode";
	readonly label = "ExitPlanMode";
	readonly description: string;
	readonly parameters = exitPlanModeSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(exitPlanModeDescription);
	}

	async execute(
		_toolCallId: string,
		params: ExitPlanModeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ExitPlanModeDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ExitPlanModeDetails>> {
		const state = this.session.getPlanModeState?.();
		if (!state?.enabled && !state?.workflowSlug && !params.workflowSlug) {
			throw new ToolError("Plan mode is not active.");
		}

		const planFilePath =
			state?.planFilePath ?? (params.workflowPhase ? `local://${params.workflowPhase.toUpperCase()}.md` : undefined);
		if (!planFilePath) {
			throw new ToolError("Cannot determine plan file path.");
		}

		const resolvedPlanPath = resolvePlanPath(this.session, planFilePath);
		let planExists = false;
		try {
			const stat = await fs.stat(resolvedPlanPath);
			planExists = stat.isFile();
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}

		if (!planExists) {
			throw new ToolError(
				`Plan file not found at ${planFilePath}. Write the output to ${planFilePath} before calling exit_plan_mode.`,
			);
		}

		// For workflow phases, title is optional
		const isWorkflowPhase = !!(params.workflowSlug && params.workflowPhase);
		if (!params.title && !isWorkflowPhase) {
			throw new ToolError('Title is required. Call exit_plan_mode({ title: "YOUR_PLAN_NAME" }).');
		}

		const titleStr = params.title ?? params.workflowPhase!;
		const normalized = normalizePlanTitle(titleStr);
		const finalPlanFilePath = `local://${normalized.fileName}`;
		if (!isWorkflowPhase) {
			resolvePlanPath(this.session, finalPlanFilePath);
		}

		return {
			content: [
				{
					type: "text",
					text: isWorkflowPhase ? "Phase complete. Ready for approval." : "Plan ready for approval.",
				},
			],
			details: {
				planFilePath,
				planExists,
				title: normalized.title,
				finalPlanFilePath: isWorkflowPhase ? undefined : finalPlanFilePath,
				workflowSlug: params.workflowSlug,
				workflowPhase: params.workflowPhase,
				reviewCompleted: params.reviewCompleted,
			},
		};
	}
}
