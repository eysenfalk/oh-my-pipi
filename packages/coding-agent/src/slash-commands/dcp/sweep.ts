import type { BuiltinSlashCommandRuntime } from "../builtin-registry";

export function handleDcpSweep(_args: string, runtime: BuiltinSlashCommandRuntime): void {
	const stats = runtime.ctx.session.sweepContextPruning();
	runtime.ctx.showStatus(`Sweep complete — pruned: ${stats.toolsPruned} tools, saved: ~${stats.tokensSaved} tokens`);
	runtime.ctx.editor.setText("");
}
