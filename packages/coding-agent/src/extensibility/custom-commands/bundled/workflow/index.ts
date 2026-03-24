import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderPromptTemplate } from "../../../../config/prompt-templates";
import type { SettingPath } from "../../../../config/settings";
import { settings } from "../../../../config/settings";
import type { HookCommandContext } from "../../../hooks/types";
import type { CustomCommand } from "../../types";
import {
	findActiveWorkflow,
	formatWorkflowStatus,
	generateSlug,
	getActiveWorkflowSlug,
	listWorkflows,
	readWorkflowArtifact,
	readWorkflowState,
	resolveWorkflowDir,
	setActiveWorkflowSlug,
	type WorkflowPhase,
	type WorkflowState,
	WORKFLOW_DIR,
	writeWorkflowArtifact,
} from "./artifacts";
import { createWorkflowConfigComponent } from "./config-component";
import brainstormPrompt from "./prompts/brainstorm-start.md" with { type: "text" };
import designPrompt from "./prompts/design-start.md" with { type: "text" };
import executePrompt from "./prompts/execute-start.md" with { type: "text" };
import finishPrompt from "./prompts/finish-start.md" with { type: "text" };
import planPrompt from "./prompts/plan-start.md" with { type: "text" };
import specPrompt from "./prompts/spec-start.md" with { type: "text" };
import verifyPrompt from "./prompts/verify-start.md" with { type: "text" };


export class WorkflowCommand implements CustomCommand {
	name = "workflow";
	description = "Multi-phase development workflow — brainstorm, spec, design, plan, execute, verify, finish";

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const [subcommand, ...rest] = args;

		if (!subcommand) {
			const status = await this.#showStatus(ctx);
			if (status) return status;
			return this.#showHelp();
		}

		switch (subcommand) {
			case "config": {
				if (!ctx.hasUI) {
					return "Use in interactive mode to configure workflow phases.";
				}
				await ctx.ui.custom((_tui, _theme, done) => createWorkflowConfigComponent(done));
				return undefined;
			}
			case "brainstorm":
				return this.#startBrainstorm(rest, ctx);
			case "spec":
				return this.#startSpec(rest, ctx);
			case "design":
				return this.#startDesign(rest, ctx);
			case "plan":
				return this.#startPlan(rest, ctx);
			case "execute":
				return this.#startExecute(rest, ctx);
			case "verify":
				return this.#startVerify(rest, ctx);
			case "finish":
				return this.#startFinish(rest, ctx);
			case "list":
				return this.#listWorkflows(ctx);
			case "switch":
				return this.#switchWorkflow(rest, ctx);
			case "resume":
				return this.#resume(rest, ctx);
			case "status":
				return this.#showDetailedStatus(rest, ctx);
			case "back":
				return "The /workflow back command is not yet implemented.";
			case "delete":
				return this.#deleteWorkflow(rest, ctx);
			case "rename":
				return this.#renameWorkflow(rest, ctx);
			case "skip":
				return this.#skipPhase(rest, ctx);
			case "abandon":
				return this.#abandonWorkflow(rest, ctx);
			default:
				return this.#showHelp();
		}
	}

	async #showStatus(ctx: HookCommandContext): Promise<string | undefined> {
		const activeSlug = await findActiveWorkflow(ctx.cwd);
		if (!activeSlug) return undefined;
		const state = await readWorkflowState(ctx.cwd, activeSlug);
		if (!state) return undefined;
		return formatWorkflowStatus(state);
	}

	async #startBrainstorm(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const topic = rest.join(" ");
		if (!topic) {
			if (!ctx.hasUI) return "Usage: /workflow brainstorm <topic>";
			const input = await ctx.ui.input("Brainstorm topic", "What do you want to build?");
			if (!input) return undefined;
			return this.#startBrainstorm([input], ctx);
		}

		const slug = generateSlug(topic);
		const workflowDir = path.join(WORKFLOW_DIR, slug);

		await ctx.newSession();
		return renderPromptTemplate(brainstormPrompt, { topic, workflowDir, slug, workflowPhase: "brainstorm" });
	}

	async #resolveSlug(rest: string[], ctx: HookCommandContext): Promise<string | null> {
		if (rest.length > 0) return rest[0];
		const active = await findActiveWorkflow(ctx.cwd);
		if (active) return active;
		if (!ctx.hasUI) return null;
		const input = await ctx.ui.input("Workflow slug", "Enter the workflow slug (YYYY-MM-DD-topic)");
		return input ?? null;
	}

	async #startSpec(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const prereqError = await this.#checkPrereq(ctx.cwd, slug, "brainstorm");
		if (prereqError) return prereqError;

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const brainstormRef = await this.#artifactRef(ctx.cwd, slug, "brainstorm");
		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(specPrompt, { workflowDir, brainstormRef, slug, workflowPhase: "spec" });
	}

	async #startDesign(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const prereqError = await this.#checkPrereq(ctx.cwd, slug, "spec");
		if (prereqError) return prereqError;

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const brainstormRef = await this.#artifactRef(ctx.cwd, slug, "brainstorm");

		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm", "spec"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(designPrompt, { workflowDir, specRef, brainstormRef, slug, workflowPhase: "design" });
	}

	async #startPlan(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const prereqError = await this.#checkPrereq(ctx.cwd, slug, "design");
		if (prereqError) return prereqError;

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const designRef = await this.#artifactRef(ctx.cwd, slug, "design");

		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm", "spec", "design"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(planPrompt, { workflowDir, specRef, designRef, slug, workflowPhase: "plan" });
	}

	async #startExecute(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const prereqError = await this.#checkPrereq(ctx.cwd, slug, "plan");
		if (prereqError) return prereqError;

		const planRef = await this.#artifactRef(ctx.cwd, slug, "plan");
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm", "spec", "design", "plan"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(executePrompt, { planRef, specRef, slug, workflowPhase: "execute" });
	}

	async #startVerify(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const planRef = await this.#artifactRef(ctx.cwd, slug, "plan");

		if (!specRef) return `No spec artifact found for workflow "${slug}".`;

		const prereqError = await this.#checkPrereq(ctx.cwd, slug, "execute");
		if (prereqError) return prereqError;

		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm", "spec", "design", "plan", "execute"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(verifyPrompt, { specRef, planRef, slug, workflowPhase: "verify" });
	}

	async #startFinish(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const prereqError = await this.#checkPrereq(ctx.cwd, slug, "verify");
		if (prereqError) return prereqError;

		const setup = await this.#populateLocalSetup(ctx.cwd, slug, [
			"brainstorm",
			"spec",
			"design",
			"plan",
			"execute",
			"verify",
		]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(finishPrompt, { slug, workflowPhase: "finish" });
	}

	async #resume(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = rest[0] ?? (await findActiveWorkflow(ctx.cwd));
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const state = await readWorkflowState(ctx.cwd, slug);
		if (!state) return `No state found for workflow "${slug}".`;

		// Determine the next phase based on current state
		const nextPhase = this.#getNextPhase(state);
		if (!nextPhase) {
			return `Workflow "${slug}" is in the "${state.currentPhase}" phase. All phases complete or unknown next step.\n\n${formatWorkflowStatus(state)}`;
		}

		// Dispatch to the appropriate phase handler
		switch (nextPhase) {
			case "spec":
				return this.#startSpec([slug], ctx);
			case "design":
				return this.#startDesign([slug], ctx);
			case "plan":
				return this.#startPlan([slug], ctx);
			case "execute":
				return this.#startExecute([slug], ctx);
			case "verify":
				return this.#startVerify([slug], ctx);
			case "finish":
				return this.#startFinish([slug], ctx);
			default:
				return `Workflow "${slug}" is at phase "${state.currentPhase}". Resume manually with /workflow <phase> ${slug}.`;
		}
	}

	async #switchWorkflow(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slugs = await listWorkflows(ctx.cwd);
		if (slugs.length === 0) {
			if (ctx.hasUI) { ctx.ui.notify("No workflows found.", "info"); return undefined; }
			return "No workflows found.";
		}

		const selected = rest[0] ?? (ctx.hasUI ? await ctx.ui.select("Switch to workflow", slugs) : null);
		if (!selected) {
			if (!ctx.hasUI) return "Usage: /workflow switch <slug>";
			return undefined;
		}

		return this.#resume([selected], ctx);
	}

	async #listWorkflows(ctx: HookCommandContext): Promise<string | undefined> {
		const slugs = await listWorkflows(ctx.cwd);
		if (slugs.length === 0) {
			if (ctx.hasUI) { ctx.ui.notify("No workflows found.", "info"); return undefined; }
			return "No workflows found.";
		}

		if (!ctx.hasUI) {
			const lines = ["Available workflows:"];
			for (const slug of slugs) {
				const state = await readWorkflowState(ctx.cwd, slug);
				lines.push(`  ${slug}${state ? ` [${state.currentPhase}]` : ""}`);
			}
			return lines.join("\n");
		}

		const items: string[] = [];
		for (const slug of slugs) {
			const state = await readWorkflowState(ctx.cwd, slug);
			items.push(state ? `${slug}  [${state.currentPhase}]` : slug);
		}

		const selected = await ctx.ui.select("Workflows (select to resume)", items);
		if (!selected) return undefined;

		const slug = selected.split("  ")[0];
		return this.#resume([slug], ctx);
	}

	#showHelp(): string {
		const cmds = [
			"brainstorm <topic>  Start new workflow",
			"spec [slug]         Write specification",
			"design [slug]       Architecture design",
			"plan [slug]         Implementation plan",
			"execute [slug]      Execute the plan",
			"verify [slug]       Verify implementation",
			"finish [slug]       Finalize workflow",
			"resume [slug]       Continue from current phase",
			"back [phase]        Re-enter a completed phase",
			"status [slug]       Show phase overview",
			"list                List all workflows",
			"switch [slug]       Switch active workflow",
			"skip <phase> [slug] Mark phase as skipped",
			"delete [slug]       Delete a workflow",
			"rename <old> <new>  Rename a workflow",
			"abandon [slug]      Mark workflow as abandoned",
			"config              Open phase configuration",
		];
		return cmds.map(l => `  /workflow ${l}`).join("\n");
	}

	async #showDetailedStatus(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No active workflow found.";
		const state = await readWorkflowState(ctx.cwd, slug);
		if (!state) return `No state found for workflow "${slug}".`;
		const order: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
		const lines = [`Workflow: ${slug}`, `Status: ${state.status ?? "active"}`, ""];
		for (const phase of order) {
			const isActive = !state.activePhases || state.activePhases.includes(phase);
			const hasArtifact = !!state.artifacts[phase];
			const isCurrent = state.currentPhase === phase;
			const marker = !isActive ? "-" : hasArtifact ? "v" : isCurrent ? ">" : "o";
			lines.push(`  ${marker} ${phase}`);
		}
		return lines.join("\n");
	}

	async #deleteWorkflow(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified.";

		if (ctx.hasUI) {
			const confirm = await ctx.ui.select(`Delete workflow "${slug}"?`, ["Yes, delete", "Cancel"]);
			if (confirm !== "Yes, delete") return undefined;
		}

		const dir = resolveWorkflowDir(ctx.cwd, slug);
		await fs.rm(dir, { recursive: true, force: true });

		const active = await getActiveWorkflowSlug(ctx.cwd);
		if (active === slug) {
			await setActiveWorkflowSlug(ctx.cwd, null);
		}

		return `Workflow "${slug}" deleted.`;
	}

	async #renameWorkflow(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		if (rest.length < 2) return "Usage: /workflow rename <old-slug> <new-slug>";
		const [oldSlug, newSlug] = rest;

		const oldDir = resolveWorkflowDir(ctx.cwd, oldSlug);
		const newDir = resolveWorkflowDir(ctx.cwd, newSlug);

		const state = await readWorkflowState(ctx.cwd, oldSlug);
		if (!state) return `No workflow "${oldSlug}" found.`;

		await fs.cp(oldDir, newDir, { recursive: true });

		// Update slug in new state.json
		state.slug = newSlug;
		await Bun.write(path.join(newDir, "state.json"), JSON.stringify(state, null, 2));
		await fs.rm(oldDir, { recursive: true, force: true });

		const active = await getActiveWorkflowSlug(ctx.cwd);
		if (active === oldSlug) {
			await setActiveWorkflowSlug(ctx.cwd, newSlug);
		}

		return `Workflow renamed: ${oldSlug} -> ${newSlug}`;
	}

	async #skipPhase(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		if (rest.length === 0) return "Usage: /workflow skip <phase> [slug]";
		const phase = rest[0] as WorkflowPhase;
		const VALID_PHASES: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
		if (!VALID_PHASES.includes(phase)) return `Unknown phase "${rest[0]}". Valid: ${VALID_PHASES.join(", ")}`;

		const slugRest = rest.slice(1);
		const slug = await this.#resolveSlug(slugRest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		await writeWorkflowArtifact(ctx.cwd, slug, phase, "(skipped)");
		return `Phase "${phase}" marked as skipped for workflow "${slug}".`;
	}

	async #abandonWorkflow(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const state = await readWorkflowState(ctx.cwd, slug);
		if (!state) return `No state found for workflow "${slug}".`;

		state.status = "abandoned";
		const dir = resolveWorkflowDir(ctx.cwd, slug);
		await Bun.write(path.join(dir, "state.json"), JSON.stringify(state, null, 2));

		const active = await getActiveWorkflowSlug(ctx.cwd);
		if (active === slug) {
			await setActiveWorkflowSlug(ctx.cwd, null);
		}

		return `Workflow "${slug}" marked as abandoned.`;
	}

	#getNextPhase(state: WorkflowState): string | null {
		const order: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
		const currentIdx = order.indexOf(state.currentPhase as WorkflowPhase);
		if (currentIdx === -1) return null;

		for (let i = currentIdx + 1; i < order.length; i++) {
			const phase = order[i];
			if (state.activePhases) {
				// Use slug-level active phases
				if (state.activePhases.includes(phase)) return phase;
			} else {
				// Fall back to global settings
				const enabled = settings.get(`workflow.phases.${phase}.enabled` as SettingPath);
				if (enabled !== false) return phase;
			}
		}
		return null;
	}

	async #artifactRef(cwd: string, slug: string, phase: string): Promise<string | null> {
		const content = await readWorkflowArtifact(cwd, slug, phase);
		if (!content) return null;
		return path.join(WORKFLOW_DIR, slug, `${phase}.md`);
	}

	/** Check if a prerequisite phase has a persisted artifact, respecting whether the phase is enabled. */
	async #checkPrereq(cwd: string, slug: string, prereq: WorkflowPhase): Promise<string | null> {
		// Read slug-level config first
		const state = await readWorkflowState(cwd, slug);
		if (state?.activePhases) {
			// Phase not in this slug's active phases — skip it
			if (!state.activePhases.includes(prereq)) return null;
			// Phase is in active phases — must have artifact
		} else {
			// No slug-level config: fall back to global settings
			const enabled = settings.get(`workflow.phases.${prereq}.enabled` as SettingPath);
			if (enabled === false) return null;
		}
		const content = await readWorkflowArtifact(cwd, slug, prereq);
		if (!content)
			return `Phase "${prereq}" has not been completed for workflow "${slug}". Run /workflow ${prereq} first.`;
		return null;
	}

	/**
	 * Pre-reads all requested phase artifacts and returns a newSession setup callback
	 * that writes them into the new session's local:// space as PHASE.md files.
	 * This lets the incoming agent read local://BRAINSTORM.md etc. directly.
	 */
	async #populateLocalSetup(
		cwd: string,
		slug: string,
		phases: WorkflowPhase[],
	): Promise<(sm: { getArtifactsDir(): string | null }) => Promise<void>> {
		const artifacts: Array<{ phase: WorkflowPhase; content: string }> = [];
		for (const phase of phases) {
			const content = await readWorkflowArtifact(cwd, slug, phase);
			if (content) artifacts.push({ phase, content });
		}
		return async sm => {
			const artifactsDir = sm.getArtifactsDir();
			if (!artifactsDir) return;
			const localDir = path.join(artifactsDir, "local");
			await fs.mkdir(localDir, { recursive: true });
			for (const { phase, content } of artifacts) {
				await Bun.write(path.join(localDir, `${phase.toUpperCase()}.md`), content);
			}
		};
	}
}

export default WorkflowCommand;
