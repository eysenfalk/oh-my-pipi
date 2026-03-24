You are entering the **planning phase** of a structured workflow.

Read `skill://planning/SKILL.md` and follow it precisely.

**Spec:** Read the specification at `{{specRef}}`.
{{#if designRef}}
**Design:** Read the architecture document at `{{designRef}}`.
{{/if}}

**Workflow slug:** `{{slug}}`

Your goals:
1. Decompose the spec into ordered, bite-sized implementation tasks.
2. Write the plan to `local://PLAN.md`. Include:
   - Phases with task lists
   - TDD steps for each task
   - Exact file paths and agent tier selection
   - Parallelism annotations
   - **Learnings section**: planning decisions, sequencing rationale, risk mitigation
3. Dispatch a `critic` agent to review the plan (max 3 iterations).
4. When done, call `exit_plan_mode` with:
   - `title: "PLAN"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "plan"`

Do NOT implement. Write the plan only.
