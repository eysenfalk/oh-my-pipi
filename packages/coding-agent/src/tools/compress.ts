/**
 * Compress tool — allows the model to summarize a range of conversation
 * context, reducing token usage while preserving key information.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { renderPromptTemplate } from "../config/prompt-templates";
import compressInstructions from "../prompts/tools/compress.md" with { type: "text" };
import type { CompressRecord } from "../session/context-pruning/types";
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

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = renderPromptTemplate(compressInstructions);
	}

	async execute(
		_toolCallId: string,
		{ topic, summary }: CompressParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<void>> {
		// upToTurn = MAX_SAFE_INTEGER covers all tool calls that exist at call time.
		// Using the live turn count from getPruningStats() was wrong: it is 0 when
		// the session hasn't gone through a full transformContext yet, causing the
		// compression to cover nothing.  The compress intent is always
		// "summarise everything I've seen so far" — a sentinel that means "all"
		// is both correct and future-proof.
		const record: CompressRecord = {
			topic,
			summary,
			upToTurn: Number.MAX_SAFE_INTEGER,
			applied: false,
			coveredIds: [],
		};

		this.#session.addCompression?.(record);

		return {
			content: [
				{
					type: "text",
					text: `Compressed context: "${topic}". Summary recorded; all existing tool calls will be hidden from context.`,
				},
			],
		};
	}
}
