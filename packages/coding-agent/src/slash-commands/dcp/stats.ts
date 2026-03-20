import type { BuiltinSlashCommandRuntime } from "../builtin-registry";

/** Show pruning statistics — stub until pruning state is exposed from AgentSession. */
export function handleDcpStats(_args: string, runtime: BuiltinSlashCommandRuntime): void {
	runtime.ctx.showStatus("No pruning stats available yet.");
	runtime.ctx.editor.setText("");
}
