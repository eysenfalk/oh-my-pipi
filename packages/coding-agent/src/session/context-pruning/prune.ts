/**
 * Apply prune operations to messages.
 * Replaces tool call input content with a compact placeholder.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { PruneState } from "./types";

const PRUNED_NOTICE = "[input pruned by context optimizer]";

/**
 * Apply the current prune map to the message array.
 * Tool calls whose IDs appear in state.pruneMap get their arguments nulled/replaced.
 * Returns a new array with pruned messages; unpruned messages are the same object references.
 */
export function applyPruneOperations(messages: AgentMessage[], state: PruneState): AgentMessage[] {
	if (state.pruneMap.size === 0) return messages;

	return messages.map(msg => {
		if (msg.role !== "assistant") return msg;

		const assistantMsg = msg as {
			role: "assistant";
			content: Array<{ type: string; id?: string; arguments?: unknown }>;
		};
		if (!Array.isArray(assistantMsg.content)) return msg;

		let modified = false;
		const newContent = assistantMsg.content.map(block => {
			if (block.type !== "toolCall" || !block.id) return block;
			if (!state.pruneMap.has(block.id)) return block;
			modified = true;
			// Replace arguments with a notice; preserve all other fields
			return { ...block, arguments: { _pruned: PRUNED_NOTICE } };
		});

		if (!modified) return msg;
		return { ...assistantMsg, content: newContent } as AgentMessage;
	});
}
