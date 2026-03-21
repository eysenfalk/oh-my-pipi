/**
 * Context pruning pipeline orchestrator.
 * Runs all enabled strategies in order, then applies prune operations.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { applyCompressions, applyPruneOperations } from "./prune";
import { syncStateFromMessages } from "./state";
import { deduplication } from "./strategies/deduplication";
import { purgeErrors } from "./strategies/purge-errors";
import { supersedeWrites } from "./strategies/supersede-writes";
import type { ContextPruningConfig, PruneState } from "./types";

/**
 * Apply all context pruning strategies to the message array.
 *
 * @param messages - Current AgentMessage[] from the session
 * @param state - Session-scoped prune state (mutated in place)
 * @param config - Pruning configuration from settings
 * @returns Modified message array (may be same reference if nothing was pruned)
 */
export function applyContextPruning(
	messages: AgentMessage[],
	state: PruneState,
	config: ContextPruningConfig,
): AgentMessage[] {
	if (!config.enabled || messages.length === 0) return messages;

	// Sync state: discover new tool calls and their outcomes
	syncStateFromMessages(state, messages);

	const sizeBefore = state.pruneMap.size;

	// Run strategies only when dirty (compress fired, sweep called, or fresh session).
	// This preserves prefix cache stability between compress invocations: the pruneMap
	// is stable across turns, so the serialized prefix is byte-identical → cache hits.
	if (state.strategiesDirty) {
		deduplication(state, config);
		purgeErrors(state, config);
		supersedeWrites(state, config);
		state.strategiesDirty = false;
	}

	// If no new prune operations and no compressions, return unchanged
	if (state.pruneMap.size === sizeBefore && state.compressions.length === 0) return messages;

	// Update cumulative stats (recomputed from full pruneMap for correctness)
	state.stats.toolsPruned = state.pruneMap.size;
	state.stats.currentTurn = state.currentTurn;
	state.stats.compressions = state.compressions.length;
	let total = 0;
	for (const tokens of state.pruneMap.values()) total += tokens;
	state.stats.tokensSaved = total;

	const pruned = applyPruneOperations(messages, state);
	return applyCompressions(pruned, state);
}
