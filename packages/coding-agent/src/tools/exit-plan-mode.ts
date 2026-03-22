import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import { currentStage, isLastStage } from "../plan-mode/state";
import exitPlanModeDescription from "../prompts/tools/exit-plan-mode.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

const exitPlanModeSchema = Type.Object({
	title: Type.Optional(
		Type.String({ description: "Final plan title — required only for the last stage, e.g. WP_MIGRATION_PLAN" }),
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
	isIntermediate: boolean;
	currentStage: string;
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
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}

		const stageName = currentStage(state);
		const intermediate = !isLastStage(state);

		const resolvedPlanPath = resolvePlanPath(this.session, state.planFilePath);
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
				`Stage file not found at ${state.planFilePath}. Write the stage output to ${state.planFilePath} before calling exit_plan_mode.`,
			);
		}

		if (intermediate) {
			return {
				content: [{ type: "text", text: "Stage complete. Ready for review and advancement to next stage." }],
				details: {
					planFilePath: state.planFilePath,
					planExists,
					isIntermediate: true,
					currentStage: stageName,
				},
			};
		}

		// Final stage: require title
		if (!params.title) {
			throw new ToolError(
				'Title is required for the final plan stage. Call exit_plan_mode({ title: "YOUR_PLAN_NAME" }).',
			);
		}
		const normalized = normalizePlanTitle(params.title);
		const finalPlanFilePath = `local://${normalized.fileName}`;
		// Validate the final path resolves correctly
		resolvePlanPath(this.session, finalPlanFilePath);

		return {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: {
				planFilePath: state.planFilePath,
				planExists,
				title: normalized.title,
				finalPlanFilePath,
				isIntermediate: false,
				currentStage: stageName,
			},
		};
	}
}
