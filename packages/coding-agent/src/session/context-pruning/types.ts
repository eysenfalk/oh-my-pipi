/**
 * Types for context pruning strategies.
 * Pruning reduces context size by identifying redundant tool calls.
 */

/** Status of a tool call execution */
export type ToolCallStatus = "pending" | "running" | "completed" | "error";

/** Metadata tracked per tool call for strategy decisions */
export interface ToolCallMetadata {
	name: string;
	arguments: unknown;
	/** Serialized signature for deduplication (tool name + sorted JSON args) */
	signature: string;
	status: ToolCallStatus;
	/** Whether the tool result was an error */
	isError: boolean;
	/** Turn number when this tool was called */
	turn: number;
	/** Estimated token count of the tool's INPUT (call arguments, not result) */
	tokenCount: number;
}

/** Per-strategy config */
export interface DeduplicationConfig {
	enabled: boolean;
	/** Tool names that are never deduplicated (e.g., read — same file may be read multiple times intentionally) */
	protectedTools: string[];
}

export interface PurgeErrorsConfig {
	enabled: boolean;
	/** Number of turns before an errored tool's input is pruned */
	turnDelay: number;
	protectedTools: string[];
}

export interface SupersedeWritesConfig {
	enabled: boolean;
}

/** Overall pruning config read from settings */
export interface ContextPruningConfig {
	enabled: boolean;
	deduplication: DeduplicationConfig;
	purgeErrors: PurgeErrorsConfig;
	supersedeWrites: SupersedeWritesConfig;
	/** Tool names never pruned by any strategy */
	protectedTools: string[];
	/** File path patterns (glob) that protect tool calls touching those paths */
	protectedFilePatterns: string[];
}

/** Running statistics */
export interface PruningStats {
	tokensSaved: number;
	toolsPruned: number;
}

/**
 * Session-scoped mutable pruning state.
 * Lives on the AgentSession instance; not persisted.
 */
export interface PruneState {
	/** toolCallId → metadata */
	toolMetadata: Map<string, ToolCallMetadata>;
	/** Ordered list of tool call IDs (matches conversation order) */
	toolIdList: string[];
	/** toolCallId → estimated token savings when pruned */
	pruneMap: Map<string, number>;
	currentTurn: number;
	stats: PruningStats;
}

/** Default protected tools — never pruned by any strategy */
export const DEFAULT_PROTECTED_TOOLS: string[] = [
	"skill",
	"read",
	"write",
	"edit",
	"task",
	"todowrite",
	"todoread",
	"compress",
];

/** Default pruning config */
export const DEFAULT_PRUNING_CONFIG: ContextPruningConfig = {
	enabled: true,
	deduplication: {
		enabled: true,
		protectedTools: [...DEFAULT_PROTECTED_TOOLS],
	},
	purgeErrors: {
		enabled: true,
		turnDelay: 4,
		protectedTools: [...DEFAULT_PROTECTED_TOOLS],
	},
	supersedeWrites: {
		enabled: true,
	},
	protectedTools: [...DEFAULT_PROTECTED_TOOLS],
	protectedFilePatterns: [],
};
