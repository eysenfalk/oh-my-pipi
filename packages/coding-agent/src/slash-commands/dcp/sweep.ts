import type { BuiltinSlashCommandRuntime } from "../builtin-registry";

/** Manual tool-output pruning sweep — stub until pruning pipeline is wired. */
export function handleDcpSweep(_args: string, runtime: BuiltinSlashCommandRuntime): void {
	runtime.ctx.showStatus("Context sweep not yet available.");
	runtime.ctx.editor.setText("");
}
