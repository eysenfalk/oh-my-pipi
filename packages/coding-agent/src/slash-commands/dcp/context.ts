import type { BuiltinSlashCommandRuntime } from "../builtin-registry";

/** Show current context usage — stub until pruning state is exposed from AgentSession. */
export function handleDcpContext(_args: string, runtime: BuiltinSlashCommandRuntime): void {
	runtime.ctx.showStatus("Context pruning: use /dcp stats for detailed statistics.");
	runtime.ctx.editor.setText("");
}
