You are entering the **design phase** of a structured workflow.

Read `skill://architecture/SKILL.md` and follow it precisely.

**Spec:** Read the specification at `{{specRef}}`.
{{#if brainstormRef}}
**Brainstorm:** Additional context at `{{brainstormRef}}`.
{{/if}}

**Workflow slug:** `{{slug}}`

Your goals:
1. Produce an agent-consumable architecture document.
2. Write the design to `local://DESIGN.md`. Include:
   - System overview and component boundaries
   - Exact file paths and module structure
   - Interface contracts and type signatures
   - Data flows and dependency graph
   - Architecture Decision Records (ADRs) for key decisions
   - **Learnings section**: design tradeoffs considered, alternatives rejected, why this approach
3. Update `docs/architecture/` with any new ADRs or architecture decisions.
4. When done, call `exit_plan_mode` with:
   - `title: "DESIGN"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "design"`

Do NOT implement. Do NOT write tasks. Architecture only.
