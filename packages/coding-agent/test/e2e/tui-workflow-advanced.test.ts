/**
 * Advanced TUI component tests for workflow UI — edge cases not covered by tui-workflow.test.ts.
 *
 * Tests HookSelectorComponent, HookInputComponent, and WorkflowConfigComponent via VirtualTerminal
 * without InteractiveMode or LLM involvement.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createWorkflowConfigComponent } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/workflow/config-component";
import { HookInputComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-input";
import { HookSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { createTUITestEnv, type TUITestEnv } from "./tui-harness";

// ANSI key sequences
const ENTER = "\n";
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const KEY_J = "j";
const KEY_K = "k";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

// ─────────────────────────────────────────────────────────────────────────────
// HookSelectorComponent — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("HookSelectorComponent — left/right/countdown/edge cases", () => {
	let env: TUITestEnv;

	afterEach(() => {
		env?.dispose();
	});

	test("left arrow triggers onLeft callback", async () => {
		env = await createTUITestEnv();
		let leftCalled = false;
		let rightCalled = false;

		const selector = new HookSelectorComponent(
			"Navigate phases",
			["Option A", "Option B"],
			() => {},
			() => {},
			{
				onLeft: () => {
					leftCalled = true;
				},
				onRight: () => {
					rightCalled = true;
				},
			},
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(LEFT);

		expect(leftCalled).toBe(true);
		expect(rightCalled).toBe(false);
	});

	test("right arrow triggers onRight callback", async () => {
		env = await createTUITestEnv();
		let rightCalled = false;

		const selector = new HookSelectorComponent(
			"Navigate phases",
			["Option A", "Option B"],
			() => {},
			() => {},
			{
				onRight: () => {
					rightCalled = true;
				},
			},
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(RIGHT);

		expect(rightCalled).toBe(true);
	});

	test("countdown timeout auto-selects current option when options non-empty", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Auto-select",
			["First", "Second"],
			option => resolve(option),
			() => resolve(undefined),
			// timeout in ms; tui required for CountdownTimer to start
			{ timeout: 500, tui: env.tui },
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Wait longer than timeout
		await Bun.sleep(700);

		const result = await promise;
		// Auto-selects the current (first) option — does NOT call onCancel
		expect(result).toBe("First");
	}, 5000);

	test("countdown timeout calls onCancel when options is empty", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Empty timeout",
			[],
			option => resolve(option),
			() => resolve(undefined),
			{ timeout: 500, tui: env.tui },
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await Bun.sleep(700);

		const result = await promise;
		// No option to select → falls through to onCancel
		expect(result).toBeUndefined();
	}, 5000);

	test("pressing a key resets countdown so timeout does not fire early", async () => {
		env = await createTUITestEnv();
		let settled = false;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Reset on key",
			["Keep", "Discard"],
			option => {
				settled = true;
				resolve(option);
			},
			() => {
				settled = true;
				resolve(undefined);
			},
			{ timeout: 800, tui: env.tui },
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Press a key at ~300ms — resets the 800ms clock
		await Bun.sleep(300);
		await env.press(KEY_J);

		// At 300 + 600 = 900ms from start, the reset clock has only run 600ms
		// (800ms needed), so it should not have fired yet.
		await Bun.sleep(600);
		expect(settled).toBe(false);

		// Clean up by selecting manually
		await env.press(ENTER);
		const result = await promise;
		expect(result).toBe("Discard"); // moved down once
	}, 10000);

	test("empty options array does not crash on render", async () => {
		env = await createTUITestEnv();

		const selector = new HookSelectorComponent(
			"No options here",
			[],
			() => {},
			() => {},
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Must not throw; render should complete
		const screen = await env.screen();
		expect(screen).toContain("No options here");
	});

	test("empty options array: Enter does nothing (no selection callback)", async () => {
		env = await createTUITestEnv();
		let selected = false;

		const selector = new HookSelectorComponent(
			"Empty",
			[],
			() => {
				selected = true;
			},
			() => {},
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(ENTER);

		expect(selected).toBe(false);
	});

	test("single option: Enter selects it without crashing", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Only one",
			["The only choice"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("The only choice");
	});

	test("single option: j does not crash and Enter still selects", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"One item",
			["Lone option"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Attempting navigation on a single-item list should clamp
		await env.press(KEY_J);
		await env.press(KEY_K);
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("Lone option");
	});

	test("30 options: position counter shows 1/30 initially", async () => {
		env = await createTUITestEnv(80, 24);
		const options = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);

		const selector = new HookSelectorComponent(
			"Large list",
			options,
			() => {},
			() => {},
			{ maxVisible: 8 },
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		const screen = await env.screen();
		// Scroll indicator is shown when total > maxVisible
		expect(screen).toContain("1/30");
	});

	test("30 options: position counter shows 2/30 after pressing j", async () => {
		env = await createTUITestEnv(80, 24);
		const options = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);

		const selector = new HookSelectorComponent(
			"Large list",
			options,
			() => {},
			() => {},
			{ maxVisible: 8 },
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(KEY_J);

		const screen = await env.screen();
		expect(screen).toContain("2/30");
	});

	test("at first option, pressing k stays at first (clamp)", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Clamp test",
			["Alpha", "Beta", "Gamma"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Press k multiple times from first position
		for (let i = 0; i < 5; i++) await env.press(KEY_K);
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("Alpha");
	});

	test("at last option, pressing j stays at last (clamp)", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Clamp test",
			["One", "Two", "Three"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// Navigate to last (index 2)
		await env.press(KEY_J);
		await env.press(KEY_J);
		// Now press j more to verify clamp
		for (let i = 0; i < 5; i++) await env.press(KEY_J);
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("Three");
	});

	test("Ctrl+C cancels the selector", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const selector = new HookSelectorComponent(
			"Approve?",
			["Yes", "No"],
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		await env.press(CTRL_C);

		const result = await promise;
		expect(result).toBeUndefined();
	});

	test("five rapid j presses advance selectedIndex by 5", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const options = ["A", "B", "C", "D", "E", "F", "G"];

		const selector = new HookSelectorComponent(
			"Rapid nav",
			options,
			option => resolve(option),
			() => resolve(undefined),
		);

		env.root.addChild(selector);
		env.tui.setFocus(selector);
		env.tui.requestRender();

		// 5 rapid j presses → index 5 (0-based) → "F"
		for (let i = 0; i < 5; i++) await env.press(KEY_J);
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("F");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// HookInputComponent — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("HookInputComponent — countdown/edge cases", () => {
	let env: TUITestEnv;

	afterEach(() => {
		env?.dispose();
	});

	test("countdown timer calls onCancel when timeout elapses", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Timed input",
			"Type here",
			value => resolve(value),
			() => resolve(undefined),
			{ timeout: 500, tui: env.tui },
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		await Bun.sleep(700);

		const result = await promise;
		expect(result).toBeUndefined();
	}, 5000);

	test("typing a character resets countdown so it does not fire early", async () => {
		env = await createTUITestEnv();
		let cancelled = false;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Reset test",
			"Type to reset",
			value => resolve(value),
			() => {
				cancelled = true;
				resolve(undefined);
			},
			{ timeout: 800, tui: env.tui },
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		// Type at 300ms — resets the 800ms clock
		await Bun.sleep(300);
		await env.press("x");

		// 600ms after reset = only 600ms elapsed; 800ms required → not fired
		await Bun.sleep(600);
		expect(cancelled).toBe(false);

		// Manually submit to unblock
		await env.press(ENTER);
		await promise;
	}, 10000);

	test("long text: 200 characters all captured on submit", async () => {
		env = await createTUITestEnv(200, 24);
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Long input",
			"type...",
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		const longText = "abcdefghij".repeat(20); // 200 chars
		for (const char of longText) {
			await env.press(char);
		}
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe(longText);
	});

	test("special characters: backslash, quotes, brackets captured correctly", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Special chars",
			"",
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		// Type characters with special meaning — none should be swallowed
		const specialText = `abc"def'ghi[jkl]`;
		for (const char of specialText) {
			await env.press(char);
		}
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe(specialText);
	});

	test("empty string placeholder renders without crash", async () => {
		env = await createTUITestEnv();

		const input = new HookInputComponent(
			"No placeholder",
			"",
			() => {},
			() => {},
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		const screen = await env.screen();
		expect(screen).toContain("No placeholder");
	});

	test("backspace deletes last character: hello → hel after two backspaces", async () => {
		env = await createTUITestEnv();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();

		const input = new HookInputComponent(
			"Backspace test",
			"",
			value => resolve(value),
			() => resolve(undefined),
		);

		env.root.addChild(input);
		env.tui.setFocus(input);
		env.tui.requestRender();

		for (const char of "hello") {
			await env.press(char);
		}
		await env.press(BACKSPACE);
		await env.press(BACKSPACE);
		await env.press(ENTER);

		const result = await promise;
		expect(result).toBe("hel");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowConfigComponent — Settings integration
// ─────────────────────────────────────────────────────────────────────────────

describe("WorkflowConfigComponent (TUI)", () => {
	let env: TUITestEnv;

	beforeEach(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		env?.dispose();
	});

	test("renders all 7 phase headers", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// Initial view (maxVisible=28 of 35 items) shows brainstorm through most of verify.
		// Scroll to the bottom to make finish visible, then verify.
		const initialScreen = await env.screen();
		const visiblePhases = ["brainstorm", "spec", "design", "plan", "execute", "verify"];
		for (const phase of visiblePhases) {
			expect(initialScreen).toContain(phase);
		}

		// Scroll to the end to expose the finish phase (item 30+)
		for (let i = 0; i < 34; i++) await env.press(DOWN);
		const bottomScreen = await env.screen();
		expect(bottomScreen).toContain("finish");
	});

	test("renders settings labels: Enabled, Approval, Review Agent, Max Review Rounds", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		const screen = await env.screen();
		expect(screen).toContain("Enabled");
		expect(screen).toContain("Approval");
		expect(screen).toContain("Review Agent");
		expect(screen).toContain("Max Review Rounds");
	});

	test("Escape closes: done() called", async () => {
		env = await createTUITestEnv(120, 40);
		let closed = false;
		const component = createWorkflowConfigComponent(() => {
			closed = true;
		});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		await env.press(ESCAPE);

		expect(closed).toBe(true);
	});

	test("scope toggle: pressing g switches [SESSION] to [GLOBAL]", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		const initialScreen = await env.screen();
		expect(initialScreen).toContain("SESSION");

		await env.press("g");

		const toggledScreen = await env.screen();
		expect(toggledScreen).toContain("GLOBAL");
		expect(toggledScreen).not.toContain("SESSION");
	});

	test("scope toggle: pressing g twice returns to [SESSION]", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		await env.press("g");
		await env.press("g");

		const screen = await env.screen();
		expect(screen).toContain("SESSION");
		expect(screen).not.toContain("GLOBAL");
	});

	test("navigation wraps: up from first item wraps to last", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// Press up from first item (index 0) — should wrap to last (index 34)
		await env.press(UP);

		const screen = await env.screen();
		// The scroll indicator should show the last item is selected
		expect(screen).toContain("35/35");
	});

	test("navigation wraps: down from last item wraps to first", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// Navigate to last item (34 downs from index 0 in a 35-item list)
		for (let i = 0; i < 34; i++) await env.press(DOWN);

		// Now wrap: one more down → back to first (index 0)
		await env.press(DOWN);

		const screen = await env.screen();
		// First item selected; scroll indicator at position 1/35
		expect(screen).toContain("1/35");
	});

	test("setting cycle: Enter on Approval cycles from first to second value", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// index 0 = header.brainstorm, index 1 = enabled, index 2 = approval
		await env.press(DOWN); // → enabled
		await env.press(DOWN); // → approval

		const screenBefore = await env.screen();
		// Default approval is "user"; cursor should be on it
		expect(screenBefore).toContain("user");

		await env.press(ENTER); // cycle: user → agent

		const screenAfter = await env.screen();
		expect(screenAfter).toContain("agent");
	});

	test("setting cycle: Space also cycles values", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		await env.press(DOWN); // → enabled
		await env.press(DOWN); // → approval (default: user)

		await env.press(" "); // cycle: user → agent

		const screen = await env.screen();
		expect(screen).toContain("agent");
	});

	test("r key resets session override: value reverts to global value", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// Navigate to approval (index 2); default value is "user"
		await env.press(DOWN); // → enabled
		await env.press(DOWN); // → approval (user)

		// Cycle to "agent" — creates a session override
		await env.press(ENTER);
		const screenWithOverride = await env.screen();
		expect(screenWithOverride).toContain("agent");

		// Press 'r' to reset the override
		await env.press("r");

		const screenAfterReset = await env.screen();
		// Value should revert to the global default ("user")
		expect(screenAfterReset).toContain("user");
	});

	test("r key in global scope does nothing", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// Switch to global scope
		await env.press("g");

		// Navigate to approval and cycle it
		await env.press(DOWN);
		await env.press(DOWN);
		await env.press(ENTER); // sets global value to "user"

		const screenBefore = await env.screen();
		expect(screenBefore).toContain("user");

		// Press 'r' — in global scope this does nothing
		await env.press("r");

		const screenAfter = await env.screen();
		// Value stays "user"; r had no effect in global scope
		expect(screenAfter).toContain("user");
	});

	test("session scope hint includes g, r, and esc", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		const screen = await env.screen();
		// All three hints should appear in session scope
		expect(screen).toContain("toggle scope");
		expect(screen).toContain("reset override");
		expect(screen).toContain("close");
	});

	test("global scope hint omits r reset override hint", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		await env.press("g"); // switch to global

		const screen = await env.screen();
		expect(screen).toContain("toggle scope");
		expect(screen).toContain("close");
		expect(screen).not.toContain("reset override");
	});

	test("override marker: * appears next to label after session change", async () => {
		env = await createTUITestEnv(120, 40);
		const component = createWorkflowConfigComponent(() => {});

		env.root.addChild(component);
		env.tui.setFocus(component);
		env.tui.requestRender();

		// Navigate to Approval and cycle value — creates override
		await env.press(DOWN);
		await env.press(DOWN);
		await env.press(ENTER);

		const screen = await env.screen();
		// Override marker should appear: "Approval *"
		expect(screen).toContain("*");
	});
});
