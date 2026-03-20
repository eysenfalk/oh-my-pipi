import type { BuiltinSlashCommandRuntime } from "../builtin-registry";

export function handleDcpContext(_args: string, runtime: BuiltinSlashCommandRuntime): void {
	const stats = runtime.ctx.session.getPruningStats();
	runtime.ctx.showStatus(
		`Context: turn ${stats.currentTurn} | pruned ${stats.toolsPruned} tools (~${stats.tokensSaved} tok) | ${stats.compressions} compress block${stats.compressions === 1 ? "" : "s"}`,
	);
	runtime.ctx.editor.setText("");
}
