import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";

const switchWorkflowSchema = Type.Object({
	slug: Type.String({
		description: "The workflow slug to switch to",
	}),
	confirm: Type.Optional(
		Type.Boolean({
			description: "If true, skip user confirmation prompt",
		}),
	),
});

type SwitchWorkflowParams = Static<typeof switchWorkflowSchema>;

export interface SwitchWorkflowDetails {
	slug: string;
	confirm: boolean | undefined;
}

export class SwitchWorkflowTool implements AgentTool<typeof switchWorkflowSchema, SwitchWorkflowDetails> {
	readonly name = "switch_workflow";
	readonly label = "SwitchWorkflow";
	readonly description =
		"Switch to a different active workflow. Use this when the conversation context shifts to a different feature. Will ask user for confirmation unless confirm=true.";
	readonly parameters = switchWorkflowSchema;
	readonly strict = true;

	constructor(readonly _session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: SwitchWorkflowParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SwitchWorkflowDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SwitchWorkflowDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "Switching to workflow...",
				},
			],
			details: {
				slug: params.slug,
				confirm: params.confirm,
			},
		};
	}
}
