/**
 * Apply prune operations to messages.
 * Replaces tool call input content with a compact placeholder.
 *
 * SAFETY: applyPruneOperations preserves the content array structure — it only
 * replaces tool call arguments, never adds/removes blocks. This makes it safe
 * for assistant messages with thinking blocks (Anthropic requires the latest
 * assistant message's thinking blocks to remain structurally identical).
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompressRecord, PruneState } from "./types";

const PRUNED_NOTICE = "[input pruned by context optimizer]";

/** Check whether an assistant message contains thinking or redactedThinking blocks. */
function hasThinkingBlocks(msg: AgentMessage): boolean {
	const a = msg as { content?: Array<{ type: string }> };
	if (!Array.isArray(a.content)) return false;
	return a.content.some(b => b.type === "thinking" || b.type === "redactedThinking");
}

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
 *
 * THINKING BLOCK SAFETY: The latest assistant message is never modified when it
 * contains thinking or redactedThinking blocks. Anthropic requires the latest
 * assistant message's thinking blocks to remain structurally identical (they carry
 * cryptographic signatures). Covered tool calls in the latest message are deferred —
 * they will be removed on the next call when a newer assistant message becomes the
 * latest. The compression summary is also deferred to avoid showing both the summary
 * and the original tool calls simultaneously.
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
	// Remove covered IDs from pruneMap to avoid double-processing in applyPruneOperations.
	// Track token savings only for IDs that were NOT already in pruneMap — those are already
	// counted in state.stats.tokensSaved (computed from pruneMap before this function runs).
	let compressionTokens = 0;
	let compressionCount = 0;
	for (const id of allCoveredCallIds) {
		if (!state.pruneMap.has(id)) {
			compressionTokens += state.toolMetadata.get(id)?.tokenCount ?? 0;
			compressionCount++;
		}
		state.pruneMap.delete(id);
	}
	state.stats.tokensSaved += compressionTokens;
	state.stats.toolsPruned += compressionCount;

	// Map toolCallId → which compression covers it (for summary injection)
	const callIdToRecord = new Map<string, CompressRecord>();
	for (const record of state.compressions) {
		for (const id of record.coveredIds) callIdToRecord.set(id, record);
	}

	// Find the last assistant message — it must not be modified if it has thinking blocks.
	// Anthropic validates that the latest assistant message's content is structurally
	// identical to what the server originally returned (signature-checked).
	const lastAssistantIdx = messages.findLastIndex(m => m.role === "assistant");

	// Build result: walk messages, skip covered calls + results, inject summaries
	const injectedRecords = new Set<CompressRecord>();
	const result: AgentMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "assistant") {
			const a = msg as { role: string; content: Array<{ type: string; id?: string }> };
			const coveredBlocks = (a.content ?? []).filter(
				b => b.type === "toolCall" && b.id && allCoveredCallIds.has(b.id),
			);

			// Guard: never strip tool calls from the latest assistant message when it
			// contains thinking blocks. The covered IDs remain tracked — they will be
			// removed on the next call when this message is no longer the latest.
			// We also skip summary injection for these deferred tool calls to avoid
			// showing both the summary and the original tool calls simultaneously.
			if (i === lastAssistantIdx && hasThinkingBlocks(msg) && coveredBlocks.length > 0) {
				result.push(msg);
				continue;
			}

			const uncoveredBlocks = (a.content ?? []).filter(
				b => !(b.type === "toolCall" && b.id && allCoveredCallIds.has(b.id)),
			);
			const hasUncoveredToolCalls = uncoveredBlocks.some(b => b.type === "toolCall");

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

			// When all tool calls in this message are covered and the remaining
			// content is only thinking/text blocks, drop the entire message.
			// The thinking/text was about the compressed tool calls — keeping
			// orphaned thinking/text blocks would create consecutive assistant
			// messages with no user messages between them, which violates the
			// Anthropic alternating-roles constraint.
			if (uncoveredBlocks.length === 0 || (!hasUncoveredToolCalls && coveredBlocks.length > 0)) continue;
			result.push({ ...msg, content: uncoveredBlocks } as AgentMessage);
			continue;
		}

		// Skip tool results whose calls were compressed (but not deferred)
		if (msg.role === "toolResult") {
			const r = msg as { role: string; toolCallId?: string };
			if (r.toolCallId && allCoveredCallIds.has(r.toolCallId)) {
				// Check if this result's tool call was deferred (still in the latest assistant message)
				const deferredBecauseOfThinking =
					lastAssistantIdx >= 0 &&
					hasThinkingBlocks(messages[lastAssistantIdx]) &&
					isToolCallInMessage(messages[lastAssistantIdx], r.toolCallId);
				if (!deferredBecauseOfThinking) continue;
			}
		}

		result.push(msg);
	}

	return result;
}

/** Check whether an assistant message contains a tool call with the given ID. */
function isToolCallInMessage(msg: AgentMessage, toolCallId: string): boolean {
	const a = msg as { content?: Array<{ type: string; id?: string }> };
	if (!Array.isArray(a.content)) return false;
	return a.content.some(b => b.type === "toolCall" && b.id === toolCallId);
}
