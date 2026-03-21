/**
 * Pruning state management: creates and syncs PruneState from AgentMessage[].
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
// Rough 4-chars-per-token approximation. Avoids importing compaction which pulls in heavy deps.
import type { CompressRecord, PruneState, ToolCallMetadata } from "./types";

/** Create a fresh empty PruneState */
export function createPruneState(): PruneState {
	return {
		toolMetadata: new Map(),
		toolIdList: [],
		pruneMap: new Map(),
		currentTurn: 0,
		strategiesDirty: true,
		compressions: [],
		stats: { tokensSaved: 0, toolsPruned: 0, currentTurn: 0, compressions: 0 },
	};
}
/**
 * Build a stable signature for deduplication.
 * Serializes tool name + sorted JSON arguments.
 */
export function buildToolSignature(name: string, args: unknown): string {
	if (args === null || args === undefined) return name;
	try {
		return `${name}::${JSON.stringify(sortObjectKeys(args as Record<string, unknown>))}`;
	} catch {
		return name;
	}
}

function sortObjectKeys(obj: unknown): unknown {
	if (typeof obj !== "object" || obj === null) return obj;
	if (Array.isArray(obj)) return obj.map(sortObjectKeys);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
		sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
	}
	return sorted;
}

/**
 * Sync PruneState from the current message list.
 * New tool calls are discovered and added; existing metadata is preserved.
 * Turn counter increments on each call (proxy for user messages).
 */
export function syncStateFromMessages(state: PruneState, messages: AgentMessage[]): void {
	// Count user messages as turn proxy
	let userMessages = 0;
	for (const msg of messages) {
		if (msg.role === "user") userMessages++;
	}
	state.currentTurn = userMessages;

	// Walk messages to discover tool calls and their results
	const seenIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "assistant") {
			const assistantMsg = msg as {
				role: "assistant";
				content: Array<{ type: string; id?: string; name?: string; arguments?: unknown }>;
			};
			for (const block of assistantMsg.content ?? []) {
				if (block.type !== "toolCall" || !block.id) continue;
				seenIds.add(block.id);
				if (state.toolMetadata.has(block.id)) continue;

				const signature = buildToolSignature(block.name ?? "", block.arguments);
				const metadata: ToolCallMetadata = {
					name: block.name ?? "",
					arguments: block.arguments,
					signature,
					status: "pending",
					isError: false,
					turn: state.currentTurn,
					tokenCount: Math.ceil(JSON.stringify(msg).length / 4),
				};
				state.toolMetadata.set(block.id, metadata);
				state.toolIdList.push(block.id);
			}
		} else if (msg.role === "toolResult") {
			const result = msg as ToolResultMessage;
			const metadata = state.toolMetadata.get(result.toolCallId);
			if (metadata) {
				metadata.status = result.isError ? "error" : "completed";
				metadata.isError = !!result.isError;
			}
		}
	}

	// Prune toolIdList to only known IDs (handles session resets)
	if (seenIds.size > 0) {
		const knownInOrder = state.toolIdList.filter(id => seenIds.has(id));
		if (knownInOrder.length !== state.toolIdList.length) {
			state.toolIdList.length = 0;
			state.toolIdList.push(...knownInOrder);
		}
	}
}

/**
 * Serialize the pruning marks (pruneMap + compressions) to a JSON string
 * for persistence in a sidecar file alongside the session JSONL.
 * Does not include transient state (toolMetadata, toolIdList, stats).
 */
export function serializePruneMarks(state: PruneState): string {
	return JSON.stringify({
		pruneMap: Array.from(state.pruneMap.entries()),
		compressions: state.compressions,
	});
}

/**
 * Restore pruning marks from a sidecar JSON string into `state`.
 * Sets `strategiesDirty = false` so strategies don't re-run unnecessarily.
 */
export function deserializePruneMarks(state: PruneState, json: string): void {
	const data = JSON.parse(json) as { pruneMap: Array<[string, number]>; compressions: CompressRecord[] };
	state.pruneMap = new Map(data.pruneMap);
	state.compressions = data.compressions ?? [];
	state.strategiesDirty = false;
}
