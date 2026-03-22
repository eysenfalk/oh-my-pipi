import { resolveLocalUrlToPath } from "../internal-urls";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const LOCAL_URL_PREFIX = "local://";

export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	if (targetPath.startsWith(LOCAL_URL_PREFIX)) {
		return resolveLocalUrlToPath(targetPath, {
			getArtifactsDir: session.getArtifactsDir,
			getSessionId: session.getSessionId,
		});
	}

	return resolveToCwd(targetPath, session.cwd);
}

export function enforceWriteGuard(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	// Read-only: block everything, no exceptions
	if (session.getReadOnlyMode?.()) {
		throw new ToolError("Read-only mode: file modifications are not allowed.");
	}

	// Plan mode: block everything except current stage file
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	if (options?.move) throw new ToolError("Plan mode: renaming files is not allowed.");
	if (options?.op === "delete") throw new ToolError("Plan mode: deleting files is not allowed.");

	const resolvedTarget = resolvePlanPath(session, targetPath);
	const resolvedPlan = resolvePlanPath(session, state.planFilePath);
	if (resolvedTarget !== resolvedPlan) {
		throw new ToolError(`Plan mode: only the current stage file may be modified (${state.planFilePath}).`);
	}
}
