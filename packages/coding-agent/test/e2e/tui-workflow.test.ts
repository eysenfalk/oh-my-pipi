/**
 * TUI wiring tests for workflow approval components.
 *
 * Tests HookSelectorComponent and HookInputComponent with VirtualTerminal
 * to verify keyboard navigation, selection, cancellation, and rendering
 * without requiring InteractiveMode or any LLM calls.
 *
 * These components are the UI surface for workflow approval gates —
 * they handle Approve/Refine/Reject selection and refinement input.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { HookInputComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-input";
import { HookSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { createTUITestEnv, type TUITestEnv } from "./tui-harness";

// Key sequences. VirtualTerminal reports kittyProtocolActive = true,
// but HookSelectorComponent also matches raw characters: j/k/\n/\x1b.
const ENTER = "\n";
const ESCAPE = "\x1b";
const KEY_J = "j";
const KEY_K = "k";

describe("HookSelectorComponent (TUI)", () => {
	let env: TUITestEnv;

	afterEach(() => {
		env?.dispose();
	});

	test("selects first option on Enter", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Approve phase?",
			["Approve", "Refine", "Reject"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Press Enter to select first option (Approve is default)
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("Approve");
	});

	test("navigates down with j and selects", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Choose action",
			["Approve", "Refine", "Reject"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Move down once, select "Refine"
		await env.press(KEY_J);
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("Refine");
	});

	test("navigates down twice with j to third option", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Choose action",
			["Approve", "Refine", "Reject"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(KEY_J);
		await env.press(KEY_J);
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("Reject");
	});

	test("navigates up with k after moving down", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Choose action",
			["Approve", "Refine", "Reject"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Down, down, up — should be on "Refine"
		await env.press(KEY_J);
		await env.press(KEY_J);
		await env.press(KEY_K);
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("Refine");
	});

	test("cancels on Escape", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Approve phase?",
			["Approve", "Refine", "Reject"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(ESCAPE);
		const result = await promise;
		expect(result).toBeUndefined();
	});

	test("does not go below last option", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Choose",
			["A", "B"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Press down 5 times — should clamp at last option
		for (let i = 0; i < 5; i++) await env.press(KEY_J);
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("B");
	});

	test("does not go above first option", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Choose",
			["A", "B", "C"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Press up 5 times from top — should stay on first
		for (let i = 0; i < 5; i++) await env.press(KEY_K);
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("A");
	});

	test("renders options in viewport", async () => {
		env = await createTUITestEnv();
		const { resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Continue to spec?",
			["Continue", "Stop here"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		const screen = await env.screen();
		// Options should be visible on screen
		expect(screen).toContain("Continue");
		expect(screen).toContain("Stop here");
	});

	test("renders title in viewport", async () => {
		env = await createTUITestEnv();
		const { resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Brainstorm complete",
			["Approve", "Refine"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		const screen = await env.screen();
		expect(screen).toContain("Brainstorm complete");
	});

	test("handles single option", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Only choice",
			["OK"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("OK");
	});

	test("handles many options with scrolling", async () => {
		env = await createTUITestEnv(80, 12); // Small viewport
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const options = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);

		const selector = new HookSelectorComponent(
			"Pick one",
			options,
			option => resolve(option),
			() => resolve(undefined),
			{ maxVisible: 5 },
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Navigate to option 10 (9 down presses)
		for (let i = 0; i < 9; i++) await env.press(KEY_J);
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("Option 10");
	});
});

describe("HookInputComponent (TUI)", () => {
	let env: TUITestEnv;

	afterEach(() => {
		env?.dispose();
	});

	test("submits typed text on Enter", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"What needs refinement?",
			"Enter feedback",
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		// Type text character by character
		for (const char of "fix the API design") {
			await env.press(char);
		}
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("fix the API design");
	});

	test("cancels on Escape", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"What needs refinement?",
			undefined,
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		// Type some text then cancel
		for (const char of "partial") {
			await env.press(char);
		}
		await env.press(ESCAPE);

		const result = await promise;
		expect(result).toBeUndefined();
	});

	test("submits empty string when Enter pressed without typing", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Optional feedback",
			undefined,
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("");
	});

	test("submits empty string when placeholder provided but user types nothing", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Workflow slug (confirm or edit)",
			"2026-03-25-my-cool-feature",
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		// User presses Enter without typing -- placeholder is NOT pre-filled,
		// so the submitted value is empty string. The caller (handleStartWorkflowTool)
		// is responsible for falling back to the recommended slug.
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("");
	});

	test("renders title in viewport", async () => {
		env = await createTUITestEnv();
		const { resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Refinement feedback",
			undefined,
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		const screen = await env.screen();
		expect(screen).toContain("Refinement feedback");
	});

	test("renders help text in viewport", async () => {
		env = await createTUITestEnv();
		const { resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Enter value",
			undefined,
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		const screen = await env.screen();
		// HookInputComponent renders "enter submit  esc cancel" help text
		expect(screen).toContain("enter");
		expect(screen).toContain("cancel");
	});
});

describe("Workflow approval flow (TUI)", () => {
	let env: TUITestEnv;

	afterEach(() => {
		env?.dispose();
	});

	test("Approve → Refine → type feedback simulates full refinement", async () => {
		env = await createTUITestEnv();

		// Step 1: Show approval selector
		const { promise: selectorPromise, resolve: selectorResolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Brainstorm phase complete",
			["Approve", "Refine", "Reject"],
			option => selectorResolve(option),
			() => selectorResolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Select "Refine" (move down once, enter)
		await env.press(KEY_J);
		await env.press(ENTER);
		const selectorResult = await selectorPromise;
		expect(selectorResult).toBe("Refine");

		// Step 2: Show refinement input (simulating what InteractiveMode does)
		env.root.removeChild(selector);

		const { promise: inputPromise, resolve: inputResolve } = Promise.withResolvers<string | undefined>();

		const refinementInput = new HookInputComponent(
			"What needs refinement?",
			"Describe changes needed",
			value => inputResolve(value),
			() => inputResolve(undefined),
		);

		env.root.addChild(refinementInput);
		env.tui.setFocus(refinementInput);
		env.tui.requestRender();

		for (const char of "needs more detail on API") {
			await env.press(char);
		}
		await env.press(ENTER);

		const inputResult = await inputPromise;
		expect(inputResult).toBe("needs more detail on API");
	});

	test("Approve → Continue simulates phase transition", async () => {
		env = await createTUITestEnv();

		// Step 1: Approve the current phase
		const { promise: approvalPromise, resolve: approvalResolve } = Promise.withResolvers<string | undefined>();

		const approval = new HookSelectorComponent(
			"Spec phase complete",
			["Approve", "Refine", "Reject"],
			option => approvalResolve(option),
			() => approvalResolve(undefined),
		);

		env.root.addChild(approval);
		env.tui.setFocus(approval);
		env.tui.requestRender();

		// Select "Approve"
		await env.press(ENTER);
		const approvalResult = await approvalPromise;
		expect(approvalResult).toBe("Approve");

		// Step 2: Continue to next phase
		env.root.removeChild(approval);

		const { promise: continuePromise, resolve: continueResolve } = Promise.withResolvers<string | undefined>();

		const continuation = new HookSelectorComponent(
			"Continue to design?",
			["Continue", "Stop here"],
			option => continueResolve(option),
			() => continueResolve(undefined),
		);

		env.root.addChild(continuation);
		env.tui.setFocus(continuation);
		env.tui.requestRender();

		// Select "Continue"
		await env.press(ENTER);
		const continueResult = await continuePromise;
		expect(continueResult).toBe("Continue");
	});

	test("Reject → Retry simulates rejection flow", async () => {
		env = await createTUITestEnv();

		const { promise: approvalPromise, resolve: approvalResolve } = Promise.withResolvers<string | undefined>();

		const approval = new HookSelectorComponent(
			"Phase complete",
			["Approve", "Refine", "Reject"],
			option => approvalResolve(option),
			() => approvalResolve(undefined),
		);

		env.root.addChild(approval);
		env.tui.setFocus(approval);
		env.tui.requestRender();

		// Navigate to "Reject" (down, down, enter)
		await env.press(KEY_J);
		await env.press(KEY_J);
		await env.press(ENTER);
		const result = await approvalPromise;
		expect(result).toBe("Reject");

		// Step 2: Choose retry or abandon
		env.root.removeChild(approval);

		const { promise: retryPromise, resolve: retryResolve } = Promise.withResolvers<string | undefined>();

		const retry = new HookSelectorComponent(
			"What would you like to do?",
			["Retry", "Abandon"],
			option => retryResolve(option),
			() => retryResolve(undefined),
		);

		env.root.addChild(retry);
		env.tui.setFocus(retry);
		env.tui.requestRender();

		await env.press(ENTER);
		const retryResult = await retryPromise;
		expect(retryResult).toBe("Retry");
	});
});
