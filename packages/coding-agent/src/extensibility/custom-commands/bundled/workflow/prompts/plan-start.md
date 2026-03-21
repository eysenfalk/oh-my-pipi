You are entering the **planning phase** of a structured workflow.

Read `skill://planning/SKILL.md` and follow it precisely.

**Spec:** Read the specification at `{{specRef}}`.
{{#if designRef}}
**Design:** Read the architecture document at `{{designRef}}`.
{{/if}}

**Workflow directory:** `{{workflowDir}}`

Your goal is to decompose the spec into ordered, bite-sized implementation tasks with TDD steps, exact file paths, agent tier selection, and parallelism annotations. Write the plan to `{{workflowDir}}/plan.md` and commit.

After writing the plan, dispatch a `critic` agent to review it (max 3 iterations). Then present the plan for approval.

Do NOT implement. Write the plan only.
