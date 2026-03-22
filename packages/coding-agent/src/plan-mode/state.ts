export const PLAN_STAGES = ["understand", "design", "review", "plan"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	autoMode?: boolean;
	workflowSlug?: string;
	stages?: PlanStage[];
	currentStageIndex?: number;
	completedStages?: Partial<Record<PlanStage, string>>;
	stageRetryCount?: number;
}

export function stageFilePath(stage: PlanStage): string {
	return `local://${stage.toUpperCase()}.md`;
}

export function isLastStage(state: PlanModeState): boolean {
	const stages = state.stages;
	if (!stages || stages.length === 0) return true;
	return (state.currentStageIndex ?? 0) >= stages.length - 1;
}

export function currentStage(state: PlanModeState): PlanStage {
	// Treat empty stages array same as undefined — fall back to single-stage.
	// Using .length guard prevents returning undefined typed as PlanStage.
	const stages: PlanStage[] = state.stages?.length ? state.stages : ["plan"];
	return stages[state.currentStageIndex ?? 0] ?? "plan";
}
