/**
 * Deduplication strategy: marks older tool calls for pruning when
 * a later call has the identical tool name + arguments signature.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ContextPruningConfig, PruneState } from "../types";

export function deduplication(state: PruneState, config: ContextPruningConfig): void {
	if (!config.deduplication.enabled) return;
	if (state.toolIdList.length === 0) return;

	const protected_ = new Set([...config.protectedTools, ...config.deduplication.protectedTools]);

	// Unpruned IDs only
	const unpruned = state.toolIdList.filter(id => !state.pruneMap.has(id));
	if (unpruned.length === 0) return;

	// Group by signature
	const signatureMap = new Map<string, string[]>();
	for (const id of unpruned) {
		const meta = state.toolMetadata.get(id);
		if (!meta) continue;
		if (protected_.has(meta.name)) continue;

		const group = signatureMap.get(meta.signature);
		if (group) {
			group.push(id);
		} else {
			signatureMap.set(meta.signature, [id]);
		}
	}

	// All except the most recent (last) in each duplicate group are pruned
	let count = 0;
	for (const [, ids] of signatureMap) {
		if (ids.length <= 1) continue;
		const toRemove = ids.slice(0, -1);
		for (const id of toRemove) {
			const meta = state.toolMetadata.get(id);
			state.pruneMap.set(id, meta?.tokenCount ?? 0);
			count++;
		}
	}

	if (count > 0) {
		logger.debug("context-pruning: deduplication marked for pruning", { count });
	}
}
