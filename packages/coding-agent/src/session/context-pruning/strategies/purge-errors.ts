/**
 * Purge-errors strategy: removes inputs from errored tool calls
 * after they are older than turnDelay turns. The error result is preserved.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ContextPruningConfig, PruneState } from "../types";

export function purgeErrors(state: PruneState, config: ContextPruningConfig): void {
	if (!config.purgeErrors.enabled) return;
	if (state.toolIdList.length === 0) return;

	const protected_ = new Set([...config.protectedTools, ...config.purgeErrors.protectedTools]);

	const turnThreshold = Math.max(1, config.purgeErrors.turnDelay);
	const unpruned = state.toolIdList.filter(id => !state.pruneMap.has(id));

	let count = 0;
	for (const id of unpruned) {
		const meta = state.toolMetadata.get(id);
		if (!meta) continue;
		if (!meta.isError) continue;
		if (protected_.has(meta.name)) continue;
		const turnAge = state.currentTurn - meta.turn;
		if (turnAge >= turnThreshold) {
			state.pruneMap.set(id, meta.tokenCount);
			count++;
		}
	}

	if (count > 0) {
		logger.debug("context-pruning: purge-errors marked for pruning", { count, turnThreshold });
	}
}
