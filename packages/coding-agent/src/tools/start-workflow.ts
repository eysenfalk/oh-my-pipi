import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";

const startWorkflowSchema = Type.Object({
	topic: Type.String({
		description: "Short description of what to build (used to generate the workflow slug)",
	}),
	slug: Type.Optional(
		Type.String({
			description: "Explicit workflow slug (YYYY-MM-DD-topic format). Auto-generated from topic if not provided.",
		}),
	),
});

type StartWorkflowParams = Static<typeof startWorkflowSchema>;

export interface StartWorkflowDetails {
	topic: string;
	slug: string | undefined;
}

export class StartWorkflowTool implements AgentTool<typeof startWorkflowSchema, StartWorkflowDetails> {
	readonly name = "start_workflow";
	readonly label = "StartWorkflow";
	readonly description =
		"Start a new workflow for a complex feature or change. Call this when the user asks to implement a feature that spans multiple development phases. Creates a new session with the brainstorm phase.";
	readonly parameters = startWorkflowSchema;
	readonly strict = true;

	constructor(readonly _session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: StartWorkflowParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<StartWorkflowDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<StartWorkflowDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "Starting workflow brainstorm...",
				},
			],
			details: {
				topic: params.topic,
				slug: params.slug,
			},
		};
	}
}
