import { describe, expect, it } from "bun:test";
import {
	getProviderConfig,
	isCachingEnabled,
	isCachingExplicit,
	type MinTokensByModel,
	resolveMinTokens,
	shouldSortTools,
} from "../src/provider-config";

// ============================================================================
// resolveMinTokens
// ============================================================================

describe("resolveMinTokens", () => {
	it("returns flat number unchanged", () => {
		expect(resolveMinTokens(1024)).toBe(1024);
		expect(resolveMinTokens(0)).toBe(0);
	});

	it("returns map default when no modelId provided", () => {
		const map: MinTokensByModel = { "claude-opus": 4096, default: 1024 };
		expect(resolveMinTokens(map)).toBe(1024);
	});

	it("matches model ID by substring", () => {
		const map: MinTokensByModel = {
			"claude-opus-4": 4096,
			"claude-sonnet-4": 2048,
			"claude-haiku": 1024,
			default: 512,
		};
		expect(resolveMinTokens(map, "claude-opus-4-20260101")).toBe(4096);
		expect(resolveMinTokens(map, "claude-sonnet-4-5")).toBe(2048);
		expect(resolveMinTokens(map, "claude-haiku-3")).toBe(1024);
	});

	it("uses default for unrecognized model", () => {
		const map: MinTokensByModel = { "claude-opus": 4096, default: 1024 };
		expect(resolveMinTokens(map, "gpt-4o")).toBe(1024);
	});

	it("is case-insensitive", () => {
		const map: MinTokensByModel = { "claude-sonnet": 2048, default: 512 };
		expect(resolveMinTokens(map, "CLAUDE-SONNET-4")).toBe(2048);
	});
});

// ============================================================================
// getProviderConfig
// ============================================================================

describe("getProviderConfig", () => {
	it("returns anthropic explicit-breakpoint config", () => {
		const cfg = getProviderConfig("anthropic");
		expect(cfg.cache.type).toBe("explicit-breakpoint");
		expect(cfg.cache.enabled).toBe(true);
		expect(cfg.cache.maxBreakpoints).toBe(4);
		expect(cfg.cache.property).toBe("cacheControl");
		expect(cfg.promptOrder.sortTools).toBe(true);
	});

	it("resolves anthropic minTokens for claude-3-opus", () => {
		const cfg = getProviderConfig("anthropic", "claude-3-opus-20240229");
		expect(cfg.cache.minTokens).toBe(2048);
	});

	it("resolves anthropic minTokens for claude-opus-4", () => {
		const cfg = getProviderConfig("anthropic", "claude-opus-4-20260101");
		expect(cfg.cache.minTokens).toBe(4096);
	});

	it("resolves anthropic default minTokens for unknown model", () => {
		const cfg = getProviderConfig("anthropic", "claude-unknown-9");
		expect(cfg.cache.minTokens).toBe(1024);
	});

	it("returns openai automatic-prefix config", () => {
		const cfg = getProviderConfig("openai");
		expect(cfg.cache.type).toBe("automatic-prefix");
		expect(cfg.cache.property).toBeNull();
		expect(cfg.cache.maxBreakpoints).toBe(0);
		expect(cfg.promptOrder.sortTools).toBe(true);
	});

	it("returns google implicit config", () => {
		const cfg = getProviderConfig("google");
		expect(cfg.cache.type).toBe("implicit");
		expect(cfg.cache.property).toBeNull();
		expect(cfg.promptOrder.sortTools).toBe(false);
	});

	it("returns amazon-bedrock with cachePoint property", () => {
		const cfg = getProviderConfig("amazon-bedrock");
		expect(cfg.cache.type).toBe("explicit-breakpoint");
		expect(cfg.cache.property).toBe("cachePoint");
	});

	it("returns openrouter as passthrough", () => {
		const cfg = getProviderConfig("openrouter");
		expect(cfg.cache.type).toBe("passthrough");
	});

	it("falls back to default for unknown provider", () => {
		const cfg = getProviderConfig("unknown-llm-provider");
		expect(cfg.cache.type).toBe("none");
		expect(cfg.cache.enabled).toBe(false);
	});

	it("returns flat numeric minTokens (not a map) after resolution", () => {
		const cfg = getProviderConfig("anthropic", "claude-3-5-sonnet-20241022");
		expect(typeof cfg.cache.minTokens).toBe("number");
	});

	it("google resolves Gemini 2.5 Pro to 4096 tokens", () => {
		const cfg = getProviderConfig("google", "gemini-2.5-pro-preview-05-06");
		expect(cfg.cache.minTokens).toBe(4096);
	});
});

// ============================================================================
// Helper predicates
// ============================================================================

describe("isCachingEnabled", () => {
	it("returns true for anthropic", () => {
		expect(isCachingEnabled("anthropic")).toBe(true);
	});

	it("returns true for openai", () => {
		expect(isCachingEnabled("openai")).toBe(true);
	});

	it("returns false for mistral (no caching)", () => {
		expect(isCachingEnabled("mistral")).toBe(false);
	});

	it("returns false for unknown provider", () => {
		expect(isCachingEnabled("no-such-llm")).toBe(false);
	});
});

describe("isCachingExplicit", () => {
	it("returns true for anthropic (explicit-breakpoint)", () => {
		expect(isCachingExplicit("anthropic")).toBe(true);
	});

	it("returns true for amazon-bedrock (explicit-breakpoint)", () => {
		expect(isCachingExplicit("amazon-bedrock")).toBe(true);
	});

	it("returns true for openrouter (passthrough)", () => {
		expect(isCachingExplicit("openrouter")).toBe(true);
	});

	it("returns false for openai (automatic-prefix)", () => {
		expect(isCachingExplicit("openai")).toBe(false);
	});

	it("returns false for google (implicit)", () => {
		expect(isCachingExplicit("google")).toBe(false);
	});
});

describe("shouldSortTools", () => {
	it("returns true for anthropic", () => {
		expect(shouldSortTools("anthropic")).toBe(true);
	});

	it("returns true for openai (prefix caching benefits from stable order)", () => {
		expect(shouldSortTools("openai")).toBe(true);
	});

	it("returns false for google (implicit caching, no ordering benefit)", () => {
		expect(shouldSortTools("google")).toBe(false);
	});

	it("returns false for unknown provider", () => {
		expect(shouldSortTools("no-such-llm")).toBe(false);
	});
});

// ============================================================================
// Tool sort in buildParams (indirect contract)
// ============================================================================

describe("provider-config contract: anthropic maxBreakpoints", () => {
	it("anthropic maxBreakpoints matches the Anthropic API hard limit", () => {
		// The Anthropic API allows up to 4 cache breakpoints.
		// This test defends against accidentally changing the default.
		const cfg = getProviderConfig("anthropic");
		expect(cfg.cache.maxBreakpoints).toBe(4);
	});

	it("amazon-bedrock maxBreakpoints matches the Bedrock API hard limit", () => {
		const cfg = getProviderConfig("amazon-bedrock");
		expect(cfg.cache.maxBreakpoints).toBe(4);
	});

	it("openai maxBreakpoints is 0 (no explicit breakpoints needed)", () => {
		const cfg = getProviderConfig("openai");
		expect(cfg.cache.maxBreakpoints).toBe(0);
	});
});
