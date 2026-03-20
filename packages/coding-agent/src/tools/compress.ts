/**
 * Compress tool — allows the model to summarize a range of conversation
 * context, reducing token usage while preserving key information.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import compressInstructions from "../prompts/tools/compress.md" with { type: "text" };
import type { ToolSession } from ".";

const compressSchema = Type.Object(
	{
		topic: Type.String({
			description: "Brief topic label for this compression (e.g., 'file exploration phase')",
		}),
		summary: Type.String({
			description:
				"Technical summary of the compressed context. Preserve decisions, file paths, errors, and key findings.",
		}),
	},
	{ additionalProperties: false },
);

type CompressParams = Static<typeof compressSchema>;

export class CompressTool implements AgentTool<typeof compressSchema, void> {
	readonly name = "compress";
	readonly label = "Compress";
	readonly description: string;
	readonly parameters = compressSchema;
	readonly strict = true;

	constructor(_session: ToolSession) {
		this.description = renderPromptTemplate(compressInstructions);
	}

	async execute(
		_toolCallId: string,
		{ topic }: CompressParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<void>> {
		// The compress tool's effect is handled by the pruning pipeline;
		// execution just acknowledges the compression.
		return {
			content: [{ type: "text", text: `Compressed "${topic}". Summary recorded in context.` }],
		};
	}
}
