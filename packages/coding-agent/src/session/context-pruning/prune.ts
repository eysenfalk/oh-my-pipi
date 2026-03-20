/**
 * Apply prune operations to messages.
 * Replaces tool call input content with a compact placeholder.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompressRecord, PruneState } from "./types";

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

/**
 * Apply compression records to a message array.
 *
 * For each unapplied compression:
 * 1. Collect all tool call IDs with turn <= record.upToTurn that aren't already covered.
 * 2. Mark those IDs in record.coveredIds and mark record.applied = true.
 * 3. Remove the assistant messages containing those tool calls, and their matching
 *    toolResult messages, from the output.
 * 4. Inject a synthetic user message with the compression summary at the position
 *    where the first removed message was.
 *
 * Already-applied compressions just filter their coveredIds from messages.
 */
export function applyCompressions(messages: AgentMessage[], state: PruneState): AgentMessage[] {
	if (state.compressions.length === 0) return messages;

	// Discover tool IDs for unapplied compressions
	for (const record of state.compressions) {
		if (record.applied) continue;
		for (const id of state.toolIdList) {
			const meta = state.toolMetadata.get(id);
			if (!meta) continue;
			if (meta.turn > record.upToTurn) continue;
			// Don't double-cover IDs already in an earlier compression
			const alreadyCovered = state.compressions.some(r => r.applied && r.coveredIds.includes(id));
			if (!alreadyCovered) record.coveredIds.push(id);
		}
		record.applied = true;
	}

	// Build the full set of covered IDs
	const allCoveredCallIds = new Set<string>();
	for (const record of state.compressions) {
		for (const id of record.coveredIds) allCoveredCallIds.add(id);
	}
	if (allCoveredCallIds.size === 0) return messages;

	// Remove covered IDs from pruneMap to avoid double-processing
	for (const id of allCoveredCallIds) state.pruneMap.delete(id);

	// Map toolCallId → which compression covers it (for summary injection)
	const callIdToRecord = new Map<string, CompressRecord>();
	for (const record of state.compressions) {
		for (const id of record.coveredIds) callIdToRecord.set(id, record);
	}

	// Build result: walk messages, skip covered calls + results, inject summaries
	const injectedRecords = new Set<CompressRecord>();
	const result: AgentMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "assistant") {
			const a = msg as { role: string; content: Array<{ type: string; id?: string }> };
			const coveredBlocks = (a.content ?? []).filter(
				b => b.type === "toolCall" && b.id && allCoveredCallIds.has(b.id),
			);
			const uncoveredBlocks = (a.content ?? []).filter(
				b => !(b.type === "toolCall" && b.id && allCoveredCallIds.has(b.id)),
			);

			// Inject summary user message for each newly-hit compression
			for (const block of coveredBlocks) {
				const record = block.id ? callIdToRecord.get(block.id) : undefined;
				if (record && !injectedRecords.has(record)) {
					injectedRecords.add(record);
					result.push({
						role: "user",
						content: `[Compressed: ${record.topic}]\n\n${record.summary}`,
						timestamp: Date.now(),
					} as unknown as AgentMessage);
				}
			}

			if (uncoveredBlocks.length === 0) continue;
			result.push({ ...msg, content: uncoveredBlocks } as AgentMessage);
			continue;
		}

		if (msg.role === "toolResult") {
			const r = msg as { role: string; toolCallId?: string };
			if (r.toolCallId && allCoveredCallIds.has(r.toolCallId)) continue;
		}

		result.push(msg);
	}

	return result;
}
