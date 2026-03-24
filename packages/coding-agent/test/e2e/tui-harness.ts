/**
 * TUI test harness for testing workflow UI components with VirtualTerminal.
 *
 * Creates a minimal TUI environment using xterm.js-backed VirtualTerminal,
 * sufficient to test HookSelectorComponent and HookInputComponent keyboard
 * interactions without needing the full InteractiveMode or any LLM.
 */

import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Container, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "@oh-my-pi/pi-tui/test/virtual-terminal";

let themeInitialized = false;

export interface TUITestEnv {
	terminal: VirtualTerminal;
	tui: TUI;
	root: Container;
	/** Send a keystroke and flush the render pipeline. */
	press(key: string): Promise<void>;
	/** Get the current viewport as a single string (lines joined by newline). */
	screen(): Promise<string>;
	/** Tear down the TUI. */
	dispose(): void;
}

/**
 * Create a minimal TUI environment for component testing.
 *
 * Returns a VirtualTerminal-backed TUI with a root container. Components
 * are added to the root, focused via tui.setFocus(), and driven with press().
 *
 * Initializes the theme on first call (required for component constructors).
 */
export async function createTUITestEnv(columns = 80, rows = 24): Promise<TUITestEnv> {
	if (!themeInitialized) {
		await initTheme();
		themeInitialized = true;
	}

	const terminal = new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const root = new Container();
	tui.addChild(root);
	tui.start();

	return {
		terminal,
		tui,
		root,
		async press(key: string) {
			terminal.sendInput(key);
			await terminal.flush();
		},
		async screen() {
			const lines = await terminal.flushAndGetViewport();
			return lines.join("\n");
		},
		dispose() {
			tui.stop();
			terminal.stop();
		},
	};
}
