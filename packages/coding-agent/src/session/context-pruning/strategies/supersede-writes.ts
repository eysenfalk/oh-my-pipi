/**
 * Supersede-writes strategy: prunes write tool inputs when the written file
 * is subsequently read. The read result captures current state; the write input
 * is then redundant context.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ContextPruningConfig, PruneState } from "../types";

/** Extract file path from common tool argument shapes */
function extractFilePath(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	const filePath = a.path ?? a.filePath ?? a.file_path;
	if (typeof filePath === "string" && filePath.length > 0) return filePath;
	return null;
}

const WRITE_TOOLS = new Set(["write", "edit", "ast_edit"]);
const READ_TOOLS = new Set(["read", "grep", "find"]);

export function supersedeWrites(state: PruneState, config: ContextPruningConfig): void {
	if (!config.supersedeWrites.enabled) return;
	if (state.toolIdList.length === 0) return;

	// Map filePath → [{id, index}] for write tools
	const writesByFile = new Map<string, { id: string; index: number }[]>();
	// Map filePath → number[] of read indices
	const readIndices = new Map<string, number[]>();

	for (let i = 0; i < state.toolIdList.length; i++) {
		const id = state.toolIdList[i];
		const meta = state.toolMetadata.get(id);
		if (!meta) continue;

		const filePath = extractFilePath(meta.arguments);
		if (!filePath) continue;

		if (WRITE_TOOLS.has(meta.name)) {
			const entry = writesByFile.get(filePath);
			if (entry) {
				entry.push({ id, index: i });
			} else {
				writesByFile.set(filePath, [{ id, index: i }]);
			}
		} else if (READ_TOOLS.has(meta.name)) {
			const entry = readIndices.get(filePath);
			if (entry) {
				entry.push(i);
			} else {
				readIndices.set(filePath, [i]);
			}
		}
	}

	let count = 0;
	for (const [filePath, writes] of writesByFile) {
		const reads = readIndices.get(filePath);
		if (!reads || reads.length === 0) continue;

		for (const write of writes) {
			if (state.pruneMap.has(write.id)) continue;
			const hasSubsequentRead = reads.some(ri => ri > write.index);
			if (hasSubsequentRead) {
				const meta = state.toolMetadata.get(write.id);
				state.pruneMap.set(write.id, meta?.tokenCount ?? 0);
				count++;
			}
		}
	}

	if (count > 0) {
		logger.debug("context-pruning: supersede-writes marked for pruning", { count });
	}
}
