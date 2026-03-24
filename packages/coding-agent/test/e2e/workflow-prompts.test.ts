import { describe, expect, test } from "bun:test";
import { renderPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import brainstormPrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/brainstorm-start.md" with {
	type: "text",
};
import designPrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/design-start.md" with {
	type: "text",
};
import executePrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/execute-start.md" with {
	type: "text",
};
import finishPrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/finish-start.md" with {
	type: "text",
};
import planPrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/plan-start.md" with {
	type: "text",
};
import specPrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/spec-start.md" with {
	type: "text",
};
import verifyPrompt from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/prompts/verify-start.md" with {
	type: "text",
};

// ---------------------------------------------------------------------------
// General contract
// ---------------------------------------------------------------------------

describe("renderPromptTemplate — general contract", () => {
	test("returns a string for any template", () => {
		const result = renderPromptTemplate(brainstormPrompt, { topic: "t", slug: "s" });
		expect(typeof result).toBe("string");
	});

	test("empty context does not throw (strict: false)", () => {
		expect(() => renderPromptTemplate(brainstormPrompt, {})).not.toThrow();
	});

	test("missing optional variables render as empty (strict: false)", () => {
		// spec template has optional brainstormRef — should not throw
		const result = renderPromptTemplate(specPrompt, { slug: "my-slug" });
		expect(typeof result).toBe("string");
		expect(result).toContain("my-slug");
	});

	test("special characters in variables pass through unescaped (noEscape: true)", () => {
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "<script>alert('xss')</script>",
			slug: 'quote"test',
		});
		// noEscape:true — HTML entities must not be substituted
		expect(result).toContain("<script>alert('xss')</script>");
		expect(result).toContain('quote"test');
	});

	test("curly braces in variable values pass through without re-rendering", () => {
		// The value itself should not be re-processed as a template
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "task {A} done",
			slug: "slug-braces",
		});
		expect(result).toContain("task {A} done");
	});
});

// ---------------------------------------------------------------------------
// Brainstorm phase
// ---------------------------------------------------------------------------

describe("brainstorm prompt", () => {
	test("renders with all variables", () => {
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "Build a new CLI tool",
			slug: "cli-tool-xyz",
		});
		expect(result).toContain("Build a new CLI tool");
		expect(result).toContain("cli-tool-xyz");
	});

	test("output contains workflow slug in multiple places", () => {
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "some topic",
			slug: "my-unique-slug-1",
		});
		const occurrences = result.split("my-unique-slug-1").length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(2);
	});

	test("output contains exit_plan_mode instruction with BRAINSTORM title", () => {
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "test",
			slug: "test-slug",
		});
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("BRAINSTORM");
	});

	test("output contains skill://brainstorming reference", () => {
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "test",
			slug: "test-slug",
		});
		expect(result).toContain("skill://brainstorming");
	});

	test("output contains propose_phases instruction", () => {
		const result = renderPromptTemplate(brainstormPrompt, {
			topic: "test",
			slug: "test-slug",
		});
		expect(result).toContain("propose_phases");
	});

	test("missing topic renders without throwing", () => {
		expect(() => renderPromptTemplate(brainstormPrompt, { slug: "s" })).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Spec phase
// ---------------------------------------------------------------------------

describe("spec prompt", () => {
	test("renders with all variables including optional brainstormRef", () => {
		const result = renderPromptTemplate(specPrompt, {
			slug: "spec-test-slug",
			brainstormRef: "local://BRAINSTORM.md",
		});
		expect(result).toContain("spec-test-slug");
		expect(result).toContain("local://BRAINSTORM.md");
		expect(result).toContain("Prior brainstorm");
	});

	test("brainstormRef block omitted when brainstormRef not provided", () => {
		const result = renderPromptTemplate(specPrompt, { slug: "spec-no-brain" });
		expect(result).not.toContain("Prior brainstorm");
		expect(result).not.toContain("brainstormRef");
	});

	test("output contains exit_plan_mode instruction with SPEC title", () => {
		const result = renderPromptTemplate(specPrompt, { slug: "spec-slug" });
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("SPEC");
	});

	test("output contains skill://spec-writing reference", () => {
		const result = renderPromptTemplate(specPrompt, { slug: "spec-slug" });
		expect(result).toContain("skill://spec-writing");
	});

	test("output contains workflow slug", () => {
		const result = renderPromptTemplate(specPrompt, { slug: "my-spec-slug" });
		expect(result).toContain("my-spec-slug");
	});

	test("empty context does not throw", () => {
		expect(() => renderPromptTemplate(specPrompt, {})).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Design phase
// ---------------------------------------------------------------------------

describe("design prompt", () => {
	test("renders with all variables including both refs", () => {
		const result = renderPromptTemplate(designPrompt, {
			slug: "design-slug",
			specRef: "local://SPEC.md",
			brainstormRef: "local://BRAINSTORM.md",
		});
		expect(result).toContain("design-slug");
		expect(result).toContain("local://SPEC.md");
		expect(result).toContain("local://BRAINSTORM.md");
		expect(result).toContain("Brainstorm");
	});

	test("brainstormRef block omitted when not provided", () => {
		const result = renderPromptTemplate(designPrompt, {
			slug: "design-no-brain",
			specRef: "local://SPEC.md",
		});
		expect(result).not.toContain("Brainstorm:");
		expect(result).not.toContain("brainstormRef");
	});

	test("specRef is always rendered", () => {
		const result = renderPromptTemplate(designPrompt, {
			slug: "design-slug",
			specRef: "artifact://spec-12345",
		});
		expect(result).toContain("artifact://spec-12345");
	});

	test("output contains exit_plan_mode instruction with DESIGN title", () => {
		const result = renderPromptTemplate(designPrompt, {
			slug: "design-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("DESIGN");
	});

	test("output contains skill://architecture reference", () => {
		const result = renderPromptTemplate(designPrompt, {
			slug: "design-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("skill://architecture");
	});

	test("output contains workflow slug", () => {
		const result = renderPromptTemplate(designPrompt, {
			slug: "my-design-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("my-design-slug");
	});
});

// ---------------------------------------------------------------------------
// Plan phase
// ---------------------------------------------------------------------------

describe("plan prompt", () => {
	test("renders with all variables including optional designRef", () => {
		const result = renderPromptTemplate(planPrompt, {
			slug: "plan-slug",
			specRef: "local://SPEC.md",
			designRef: "local://DESIGN.md",
		});
		expect(result).toContain("plan-slug");
		expect(result).toContain("local://SPEC.md");
		expect(result).toContain("local://DESIGN.md");
		expect(result).toContain("Design");
	});

	test("designRef block omitted when not provided", () => {
		const result = renderPromptTemplate(planPrompt, {
			slug: "plan-no-design",
			specRef: "local://SPEC.md",
		});
		expect(result).not.toContain("designRef");
		// The "Design:" label inside the if block should not appear
		expect(result).not.toContain("local://DESIGN.md");
	});

	test("specRef is always rendered", () => {
		const result = renderPromptTemplate(planPrompt, {
			slug: "plan-slug",
			specRef: "artifact://spec-999",
		});
		expect(result).toContain("artifact://spec-999");
	});

	test("output contains exit_plan_mode instruction with PLAN title", () => {
		const result = renderPromptTemplate(planPrompt, {
			slug: "plan-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("PLAN");
	});

	test("output contains skill://planning reference", () => {
		const result = renderPromptTemplate(planPrompt, {
			slug: "plan-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("skill://planning");
	});

	test("output contains workflow slug", () => {
		const result = renderPromptTemplate(planPrompt, {
			slug: "my-plan-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("my-plan-slug");
	});
});

// ---------------------------------------------------------------------------
// Execute phase
// ---------------------------------------------------------------------------

describe("execute prompt", () => {
	test("renders with all variables including optional designRef", () => {
		const result = renderPromptTemplate(executePrompt, {
			slug: "execute-slug",
			planRef: "local://PLAN.md",
			specRef: "local://SPEC.md",
			designRef: "local://DESIGN.md",
		});
		expect(result).toContain("execute-slug");
		expect(result).toContain("local://PLAN.md");
		expect(result).toContain("local://SPEC.md");
		expect(result).toContain("local://DESIGN.md");
	});

	test("designRef block omitted when not provided", () => {
		const result = renderPromptTemplate(executePrompt, {
			slug: "execute-no-design",
			planRef: "local://PLAN.md",
			specRef: "local://SPEC.md",
		});
		expect(result).not.toContain("local://DESIGN.md");
		expect(result).not.toContain("designRef");
	});

	test("planRef and specRef are always rendered", () => {
		const result = renderPromptTemplate(executePrompt, {
			slug: "execute-slug",
			planRef: "artifact://plan-42",
			specRef: "artifact://spec-42",
		});
		expect(result).toContain("artifact://plan-42");
		expect(result).toContain("artifact://spec-42");
	});

	test("output contains exit_plan_mode instruction with EXECUTE title", () => {
		const result = renderPromptTemplate(executePrompt, {
			slug: "execute-slug",
			planRef: "local://PLAN.md",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("EXECUTE");
	});

	test("output contains skill://tdd reference", () => {
		const result = renderPromptTemplate(executePrompt, {
			slug: "execute-slug",
			planRef: "local://PLAN.md",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("skill://tdd");
	});

	test("output contains workflow slug", () => {
		const result = renderPromptTemplate(executePrompt, {
			slug: "my-execute-slug",
			planRef: "local://PLAN.md",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("my-execute-slug");
	});

	test("empty context does not throw", () => {
		expect(() => renderPromptTemplate(executePrompt, {})).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Verify phase
// ---------------------------------------------------------------------------

describe("verify prompt", () => {
	test("renders with all variables including optional planRef", () => {
		const result = renderPromptTemplate(verifyPrompt, {
			slug: "verify-slug",
			specRef: "local://SPEC.md",
			planRef: "local://PLAN.md",
		});
		expect(result).toContain("verify-slug");
		expect(result).toContain("local://SPEC.md");
		expect(result).toContain("local://PLAN.md");
		expect(result).toContain("Plan");
	});

	test("planRef block omitted when not provided", () => {
		const result = renderPromptTemplate(verifyPrompt, {
			slug: "verify-no-plan",
			specRef: "local://SPEC.md",
		});
		expect(result).not.toContain("local://PLAN.md");
		expect(result).not.toContain("planRef");
	});

	test("specRef is always rendered", () => {
		const result = renderPromptTemplate(verifyPrompt, {
			slug: "verify-slug",
			specRef: "artifact://spec-verify",
		});
		expect(result).toContain("artifact://spec-verify");
	});

	test("output contains exit_plan_mode instruction with VERIFY title", () => {
		const result = renderPromptTemplate(verifyPrompt, {
			slug: "verify-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("VERIFY");
	});

	test("output contains skill://verification reference", () => {
		const result = renderPromptTemplate(verifyPrompt, {
			slug: "verify-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("skill://verification");
	});

	test("output contains workflow slug", () => {
		const result = renderPromptTemplate(verifyPrompt, {
			slug: "my-verify-slug",
			specRef: "local://SPEC.md",
		});
		expect(result).toContain("my-verify-slug");
	});

	test("empty context does not throw", () => {
		expect(() => renderPromptTemplate(verifyPrompt, {})).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Finish phase
// ---------------------------------------------------------------------------

describe("finish prompt", () => {
	test("renders with slug variable", () => {
		const result = renderPromptTemplate(finishPrompt, { slug: "finish-slug-abc" });
		expect(result).toContain("finish-slug-abc");
	});

	test("output contains exit_plan_mode instruction with FINISH title", () => {
		const result = renderPromptTemplate(finishPrompt, { slug: "finish-slug" });
		expect(result).toContain("exit_plan_mode");
		expect(result).toContain("FINISH");
	});

	test("output contains skill://finishing reference", () => {
		const result = renderPromptTemplate(finishPrompt, { slug: "finish-slug" });
		expect(result).toContain("skill://finishing");
	});

	test("empty context does not throw", () => {
		expect(() => renderPromptTemplate(finishPrompt, {})).not.toThrow();
	});

	test("extra context variables are silently ignored", () => {
		// finish template only uses slug — extra keys must not cause errors
		const result = renderPromptTemplate(finishPrompt, {
			slug: "finish-slug",
			specRef: "local://SPEC.md",
			planRef: "local://PLAN.md",
		});
		expect(result).toContain("finish-slug");
	});

	test("result is non-empty string", () => {
		const result = renderPromptTemplate(finishPrompt, { slug: "finish-slug" });
		expect(result.length).toBeGreaterThan(0);
	});
});
