/**
 * Provider Configuration System
 *
 * Provider-specific caching and prompt ordering defaults.
 * Three caching paradigms:
 *
 * 1. Explicit Breakpoint (Anthropic, Bedrock) — explicit cache markers placed on
 *    specific message positions; Anthropic uses `cacheControl`, Bedrock uses `cachePoint`.
 *
 * 2. Automatic Prefix (OpenAI, DeepSeek, GitHub Copilot) — caching is automatic
 *    based on prefix matching; no explicit markers needed, but tool sorting helps.
 *
 * 3. Implicit/Content-based (Google/Gemini) — provider manages caching via content
 *    hashing; large minTokens threshold must be met.
 *
 * NOTE: minTokens values are hardcoded because providers don't expose this metadata
 * via API discovery. Values are derived from provider documentation:
 * - Anthropic: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 * - OpenAI: https://platform.openai.com/docs/guides/prompt-caching
 * - Google: https://ai.google.dev/gemini-api/docs/caching
 */

/** How caching is applied for a provider */
export type CacheType = "explicit-breakpoint" | "automatic-prefix" | "implicit" | "passthrough" | "none";

/** Cache time-to-live */
export type CacheTTL = "5m" | "1h" | "auto";

/** Prompt section identifiers */
export type PromptSection = "tools" | "instructions" | "environment" | "system" | "messages";

/**
 * Model family pattern map for per-model minTokens.
 * Keys are lowercased substrings matched against model IDs.
 * `default` is the fallback for unrecognized models.
 */
export interface MinTokensByModel {
	[pattern: string]: number;
	default: number;
}

/** Caching configuration for a provider */
export interface ProviderCacheConfig {
	/** Whether caching is enabled */
	enabled: boolean;
	/** Type of caching mechanism */
	type: CacheType;
	/** Property name used for cache markers (null = no explicit markers) */
	property: string | null;
	/** Order of sections to apply cache breakpoints (explicit-breakpoint only) */
	hierarchy: PromptSection[];
	/** Time-to-live for cached content */
	ttl: CacheTTL;
	/**
	 * Minimum tokens required for caching. May be a flat number or per-model map.
	 * After `getConfig()` resolves a model, this is always a number.
	 */
	minTokens: number | MinTokensByModel;
	/** Maximum cache breakpoints (explicit-breakpoint providers only) */
	maxBreakpoints: number;
}

/** Prompt ordering configuration for a provider */
export interface ProviderPromptOrderConfig {
	/** Order of prompt sections for optimal caching */
	ordering: PromptSection[];
	/** Sections that should receive cache breakpoints */
	cacheBreakpoints: PromptSection[];
	/** Whether to combine all system content into one block */
	combineSystemMessages: boolean;
	/** How system prompts are passed to the provider */
	systemPromptMode: "role" | "parameter" | "systemInstruction";
	/** Whether tools can be cached (explicit-breakpoint providers only) */
	toolCaching: boolean;
	/** Whether provider requires alternating user/assistant messages */
	requiresAlternatingRoles: boolean;
	/** Whether to sort tools alphabetically for stable prefix cache hits */
	sortTools: boolean;
}

/** Complete resolved provider configuration */
export interface ResolvedProviderConfig {
	cache: ProviderCacheConfig;
	promptOrder: ProviderPromptOrderConfig;
}

// ============================================================================
// Provider Defaults
// ============================================================================

/**
 * Default configurations keyed by provider ID.
 * Use `getConfig(providerId, modelId)` rather than accessing this directly —
 * it handles fallback and minTokens resolution.
 */
const PROVIDER_DEFAULTS: Record<string, ResolvedProviderConfig> = {
	// ── Explicit Breakpoint Providers ──────────────────────────────────────────
	// These require explicit cache markers placed at specific positions.

	anthropic: {
		cache: {
			enabled: true,
			type: "explicit-breakpoint",
			property: "cacheControl",
			hierarchy: ["tools", "system", "messages"],
			ttl: "5m",
			minTokens: {
				// Claude 4.x
				"claude-opus-4": 4096,
				"claude-opus-4-5": 4096,
				"claude-opus-4.5": 4096,
				"claude-sonnet-4": 2048,
				"claude-sonnet-4-5": 2048,
				"claude-sonnet-4.5": 2048,
				"claude-haiku-4": 2048,
				"claude-haiku-4-5": 2048,
				"claude-haiku-4.5": 2048,
				// Claude 3.x
				"claude-3-opus": 2048,
				"claude-3-5-opus": 2048,
				"claude-3-sonnet": 1024,
				"claude-3-5-sonnet": 2048,
				"claude-3-haiku": 1024,
				"claude-3-5-haiku": 2048,
				default: 1024,
			},
			maxBreakpoints: 4,
		},
		promptOrder: {
			ordering: ["tools", "instructions", "environment", "system", "messages"],
			cacheBreakpoints: ["tools", "system", "messages"],
			combineSystemMessages: false,
			systemPromptMode: "parameter",
			toolCaching: true,
			requiresAlternatingRoles: true,
			sortTools: true,
		},
	},

	"amazon-bedrock": {
		cache: {
			enabled: true,
			type: "explicit-breakpoint",
			property: "cachePoint",
			hierarchy: ["system", "messages", "tools"],
			ttl: "5m",
			minTokens: {
				// Amazon Nova
				"nova-micro": 1000,
				"nova-lite": 1000,
				"nova-pro": 1000,
				"nova-premier": 1000,
				// Claude 4.x
				"claude-opus-4": 4096,
				"claude-opus-4-5": 4096,
				"claude-opus-4.5": 4096,
				"claude-sonnet-4": 2048,
				"claude-sonnet-4-5": 2048,
				"claude-sonnet-4.5": 2048,
				"claude-haiku-4": 2048,
				"claude-haiku-4-5": 2048,
				"claude-haiku-4.5": 2048,
				// Claude 3.x
				"claude-3-opus": 2048,
				"claude-3-5-opus": 2048,
				"claude-3-sonnet": 1024,
				"claude-3-5-sonnet": 2048,
				"claude-3-haiku": 1024,
				"claude-3-5-haiku": 2048,
				default: 1024,
			},
			maxBreakpoints: 4,
		},
		promptOrder: {
			ordering: ["system", "instructions", "environment", "messages", "tools"],
			cacheBreakpoints: ["system", "messages", "tools"],
			combineSystemMessages: false,
			systemPromptMode: "parameter",
			toolCaching: true,
			requiresAlternatingRoles: true,
			sortTools: true,
		},
	},

	// ── Automatic Prefix Providers ─────────────────────────────────────────────
	// No explicit markers; caching is based on token prefix matching.
	// Consistent tool ordering improves cache hit rate.

	openai: {
		cache: {
			enabled: true,
			type: "automatic-prefix",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: 1024,
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["instructions", "tools", "environment", "system", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "role",
			toolCaching: false,
			requiresAlternatingRoles: false,
			sortTools: true,
		},
	},

	azure: {
		cache: {
			enabled: true,
			type: "automatic-prefix",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: 1024,
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["instructions", "tools", "environment", "system", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "role",
			toolCaching: false,
			requiresAlternatingRoles: false,
			sortTools: true,
		},
	},

	"github-copilot": {
		cache: {
			enabled: true,
			type: "automatic-prefix",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: 1024,
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["instructions", "tools", "environment", "system", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "role",
			toolCaching: false,
			requiresAlternatingRoles: false,
			sortTools: true,
		},
	},

	deepseek: {
		cache: {
			enabled: true,
			type: "automatic-prefix",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: 0,
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["instructions", "tools", "environment", "system", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "role",
			toolCaching: false,
			requiresAlternatingRoles: false,
			sortTools: true,
		},
	},

	openrouter: {
		cache: {
			enabled: true,
			type: "passthrough",
			property: "cache_control",
			hierarchy: ["tools", "system", "messages"],
			ttl: "5m",
			minTokens: 1024,
			maxBreakpoints: 4,
		},
		promptOrder: {
			ordering: ["tools", "instructions", "environment", "system", "messages"],
			cacheBreakpoints: ["tools", "system"],
			combineSystemMessages: false,
			systemPromptMode: "parameter",
			toolCaching: true,
			requiresAlternatingRoles: true,
			sortTools: true,
		},
	},

	// ── Implicit Caching Providers ─────────────────────────────────────────────
	// Provider manages caching; content must exceed minTokens threshold.

	google: {
		cache: {
			enabled: true,
			type: "implicit",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: {
				"gemini-2.5-pro": 4096,
				"gemini-2.5-flash": 2048,
				"gemini-2.0-flash": 2048,
				"gemini-2.0-pro": 4096,
				"gemini-3": 2048,
				default: 2048,
			},
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["system", "instructions", "environment", "tools", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "systemInstruction",
			toolCaching: false,
			requiresAlternatingRoles: true,
			sortTools: false,
		},
	},

	"google-vertex": {
		cache: {
			enabled: true,
			type: "implicit",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: {
				"gemini-2.5-pro": 4096,
				"gemini-2.5-flash": 2048,
				"gemini-2.0-flash": 2048,
				"gemini-2.0-pro": 4096,
				"gemini-3": 2048,
				default: 2048,
			},
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["system", "instructions", "environment", "tools", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "systemInstruction",
			toolCaching: false,
			requiresAlternatingRoles: true,
			sortTools: false,
		},
	},

	// ── No Caching Providers ───────────────────────────────────────────────────

	mistral: {
		cache: {
			enabled: false,
			type: "none",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: 0,
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["system", "instructions", "environment", "tools", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "role",
			toolCaching: false,
			requiresAlternatingRoles: false,
			sortTools: false,
		},
	},

	// ── Default Fallback ───────────────────────────────────────────────────────

	default: {
		cache: {
			enabled: false,
			type: "none",
			property: null,
			hierarchy: [],
			ttl: "auto",
			minTokens: 0,
			maxBreakpoints: 0,
		},
		promptOrder: {
			ordering: ["system", "instructions", "environment", "tools", "messages"],
			cacheBreakpoints: [],
			combineSystemMessages: true,
			systemPromptMode: "role",
			toolCaching: false,
			requiresAlternatingRoles: false,
			sortTools: false,
		},
	},
};

// ============================================================================
// Config Resolution
// ============================================================================

/**
 * Resolve minTokens for a specific model ID.
 * Scans the pattern map for the first substring match against the lowercased model ID.
 */
export function resolveMinTokens(minTokens: number | MinTokensByModel, modelId?: string): number {
	if (typeof minTokens === "number") return minTokens;
	if (!modelId) return minTokens.default;

	const id = modelId.toLowerCase();
	for (const [pattern, tokens] of Object.entries(minTokens)) {
		if (pattern === "default") continue;
		if (id.includes(pattern)) return tokens;
	}
	return minTokens.default;
}

/**
 * Get fully resolved provider configuration.
 *
 * @param providerId - Provider identifier (e.g., "anthropic", "openai", "google")
 * @param modelId - Optional model ID for per-model minTokens resolution
 * @returns Resolved configuration with flat numeric minTokens
 */
export function getProviderConfig(providerId: string, modelId?: string): ResolvedProviderConfig {
	const defaults = PROVIDER_DEFAULTS[providerId] ?? PROVIDER_DEFAULTS.default;

	// Resolve model-specific minTokens to a flat number
	const resolvedMinTokens = resolveMinTokens(defaults.cache.minTokens, modelId);
	if (resolvedMinTokens === defaults.cache.minTokens) {
		// Already a number, no copy needed
		return defaults;
	}

	return {
		...defaults,
		cache: { ...defaults.cache, minTokens: resolvedMinTokens },
	};
}

/** Whether explicit cache markers should be applied for this provider */
export function isCachingExplicit(providerId: string): boolean {
	const cfg = PROVIDER_DEFAULTS[providerId] ?? PROVIDER_DEFAULTS.default;
	return cfg.cache.type === "explicit-breakpoint" || cfg.cache.type === "passthrough";
}

/** Whether tools should be sorted for stable prefix-cache hits */
export function shouldSortTools(providerId: string): boolean {
	const cfg = PROVIDER_DEFAULTS[providerId] ?? PROVIDER_DEFAULTS.default;
	return cfg.promptOrder.sortTools;
}

/** Whether caching is enabled for this provider at all */
export function isCachingEnabled(providerId: string): boolean {
	const cfg = PROVIDER_DEFAULTS[providerId] ?? PROVIDER_DEFAULTS.default;
	return cfg.cache.enabled;
}
