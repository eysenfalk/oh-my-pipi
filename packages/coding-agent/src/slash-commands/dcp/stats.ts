import type { BuiltinSlashCommandRuntime } from "../builtin-registry";

export function handleDcpStats(_args: string, runtime: BuiltinSlashCommandRuntime): void {
	const stats = runtime.ctx.session.getPruningStats();
	runtime.ctx.showStatus(
		`Context pruning — pruned: ${stats.toolsPruned} tools, saved: ~${stats.tokensSaved} tokens (turn ${stats.currentTurn})`,
	);
	runtime.ctx.editor.setText("");
}
