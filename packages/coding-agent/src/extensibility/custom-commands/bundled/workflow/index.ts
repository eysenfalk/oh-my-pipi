import * as path from "node:path";
import { renderPromptTemplate } from "../../../../config/prompt-templates";
import type { SettingPath, SettingValue } from "../../../../config/settings";
import { settings } from "../../../../config/settings";
import type { HookCommandContext } from "../../../hooks/types";
import type { CustomCommand } from "../../types";
import {
	findActiveWorkflow,
	formatWorkflowStatus,
	generateSlug,
	readWorkflowArtifact,
	readWorkflowState,
	type WorkflowState,
} from "./artifacts";

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
				const stages: ReadonlyArray<{ key: SettingPath; label: string }> = [
					{ key: "planning.stages.understand" as SettingPath, label: "understand" },
					{ key: "planning.stages.design" as SettingPath, label: "design" },
					{ key: "planning.stages.review" as SettingPath, label: "review" },
				];
				if (!ctx.hasUI) {
					const active = stages.filter(s => settings.get(s.key)).map(s => s.label);
					active.push("plan");
					return `Planning stages: ${active.join(" → ")} (use in interactive mode to configure)`;
				}
				for (const { key, label } of stages) {
					const current = settings.get(key) as boolean;
					const confirmed = await ctx.ui.confirm(
						`Enable "${label}" stage?`,
						`Currently: ${current ? "ON" : "OFF"}. The "plan" stage is always enabled.`,
					);
					settings.set(key, confirmed as SettingValue<SettingPath>);
				}
				const configured = stages.filter(s => settings.get(s.key)).map(s => s.label);
				configured.push("plan");
				return `Planning stages configured: ${configured.join(" → ")}`;
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
		return renderPromptTemplate(brainstormPrompt, { topic, workflowDir });
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

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const brainstormRef = await this.#artifactRef(ctx.cwd, slug, "brainstorm");

		await ctx.newSession();
		return renderPromptTemplate(specPrompt, { workflowDir, brainstormRef });
	}

	async #startDesign(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const brainstormRef = await this.#artifactRef(ctx.cwd, slug, "brainstorm");

		if (!specRef) return `No spec artifact found for workflow "${slug}". Run the spec phase first.`;

		await ctx.newSession();
		return renderPromptTemplate(designPrompt, { workflowDir, specRef, brainstormRef });
	}

	async #startPlan(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const workflowDir = path.join(WORKFLOW_DIR, slug);
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const designRef = await this.#artifactRef(ctx.cwd, slug, "design");

		if (!specRef) return `No spec artifact found for workflow "${slug}". Run the spec phase first.`;

		await ctx.newSession();
		return renderPromptTemplate(planPrompt, { workflowDir, specRef, designRef });
	}

	async #startExecute(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const planRef = await this.#artifactRef(ctx.cwd, slug, "plan");
		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");

		if (!planRef) return `No plan artifact found for workflow "${slug}". Run the plan phase first.`;

		await ctx.newSession();
		return renderPromptTemplate(executePrompt, { planRef, specRef });
	}

	async #startVerify(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		const specRef = await this.#artifactRef(ctx.cwd, slug, "spec");
		const planRef = await this.#artifactRef(ctx.cwd, slug, "plan");

		if (!specRef) return `No spec artifact found for workflow "${slug}".`;

		await ctx.newSession();
		return renderPromptTemplate(verifyPrompt, { specRef, planRef });
	}

	async #startFinish(rest: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const slug = await this.#resolveSlug(rest, ctx);
		if (!slug) return "No workflow slug specified and no active workflow found.";

		await ctx.newSession();
		return renderPromptTemplate(finishPrompt, {});
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
		const order = ["brainstorm", "spec", "design", "plan", "execute", "verify", "finish"];
		const currentIdx = order.indexOf(state.currentPhase);
		if (currentIdx === -1 || currentIdx >= order.length - 1) return null;
		return order[currentIdx + 1];
	}

	async #artifactRef(cwd: string, slug: string, phase: string): Promise<string | null> {
		const content = await readWorkflowArtifact(cwd, slug, phase);
		if (!content) return null;
		return path.join(WORKFLOW_DIR, slug, `${phase}.md`);
	}
}

export default WorkflowCommand;
