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
	readWorkflowArtifact,
	readWorkflowState,
	type WorkflowPhase,
	type WorkflowState,
} from "./artifacts";
import { createWorkflowConfigComponent } from "./config-component";
import brainstormPrompt from "./prompts/brainstorm-start.md" with { type: "text" };
import designPrompt from "./prompts/design-start.md" with { type: "text" };
import executePrompt from "./prompts/execute-start.md" with { type: "text" };
import finishPrompt from "./prompts/finish-start.md" with { type: "text" };
import planPrompt from "./prompts/plan-start.md" with { type: "text" };
import specPrompt from "./prompts/spec-start.md" with { type: "text" };
import verifyPrompt from "./prompts/verify-start.md" with { type: "text" };

const WORKFLOW_DIR = "docs/workflow";

export class WorkflowCommand implements CustomCommand {
	name = "workflow";
	description = "Multi-phase development workflow — brainstorm, spec, design, plan, execute, verify, finish";

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const [subcommand, ...rest] = args;

		if (!subcommand) {
			return this.#showStatus(ctx);
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
			case "resume":
				return this.#resume(rest, ctx);
			default:
				// Treat unknown subcommand as a brainstorm topic
				return this.#startBrainstorm(args, ctx);
		}
	}

	async #showStatus(ctx: HookCommandContext): Promise<string | undefined> {
		const activeSlug = await findActiveWorkflow(ctx.cwd);
		if (!activeSlug) {
			return "No active workflow found. Start one with `/workflow brainstorm <topic>` or `/workflow spec`.";
		}
		const state = await readWorkflowState(ctx.cwd, activeSlug);
		if (!state) {
			return "No active workflow found.";
		}
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

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const brainstormRef = await this.#artifactRef(ctx.cwd, slug, "brainstorm");

		if (!specRef) return `No spec artifact found for workflow "${slug}". Run the spec phase first.`;

		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm", "spec"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(designPrompt, { workflowDir, specRef, brainstormRef, slug, workflowPhase: "design" });
	}

	async #startPlan(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const designRef = await this.#artifactRef(ctx.cwd, slug, "design");

		if (!specRef) return `No spec artifact found for workflow "${slug}". Run the spec phase first.`;

		const setup = await this.#populateLocalSetup(ctx.cwd, slug, ["brainstorm", "spec", "design"]);
		await ctx.newSession({ setup });
		return renderPromptTemplate(planPrompt, { workflowDir, specRef, designRef, slug, workflowPhase: "plan" });
	}

	async #startExecute(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const planRef = await this.#artifactRef(ctx.cwd, slug, "plan");
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");

		if (!planRef) return `No plan artifact found for workflow "${slug}". Run the plan phase first.`;

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

	#getNextPhase(state: WorkflowState): string | null {
		const order: WorkflowPhase[] = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
		const currentIdx = order.indexOf(state.currentPhase as WorkflowPhase);
		if (currentIdx === -1) return null;

		for (let i = currentIdx + 1; i < order.length; i++) {
			const phase = order[i];
			const enabled = settings.get(`workflow.phases.${phase}.enabled` as SettingPath);
			if (enabled !== false) {
				return phase;
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
		const enabled = settings.get(`workflow.phases.${prereq}.enabled` as SettingPath);
		if (enabled === false) return null;
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
