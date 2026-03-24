import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSession } from ".";

const proposePhasesSchema = Type.Object({
	phases: Type.Array(Type.String(), {
		description:
			'Ordered list of workflow phases to run (e.g. ["brainstorm", "execute", "verify"]). Valid values: brainstorm, spec, design, plan, execute, verify, finish.',
	}),
	rationale: Type.String({
		description: "Brief explanation of why these phases are needed/skipped.",
	}),
});

type ProposePhasesParams = Static<typeof proposePhasesSchema>;

export interface ProposePhasesDetails {
	phases: string[];
	rationale: string;
}

export class ProposePhasesTool implements AgentTool<typeof proposePhasesSchema, ProposePhasesDetails> {
	readonly name = "propose_phases";
	readonly label = "ProposePhases";
	readonly description =
		"Propose the workflow phases for this project. Call this during brainstorm after analyzing the scope, BEFORE calling exit_plan_mode. The proposed phases will be shown to the user for confirmation and saved to the workflow state.";
	readonly parameters = proposePhasesSchema;
	readonly strict = true;

	constructor(readonly _session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: ProposePhasesParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ProposePhasesDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ProposePhasesDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "Phase proposal recorded. Proceed to call exit_plan_mode.",
				},
			],
			details: {
				phases: params.phases,
				rationale: params.rationale,
			},
		};
	}
}
