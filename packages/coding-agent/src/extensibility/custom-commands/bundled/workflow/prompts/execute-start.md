You are entering the **execution phase** of a structured workflow.

Read `skill://tdd/SKILL.md` for the TDD process.
Read `skill://agent-orchestration/SKILL.md` for subagent dispatch patterns.

**Plan:** Read the implementation plan at `{{planRef}}`.
**Spec:** Read the specification at `{{specRef}}` for acceptance criteria.
{{#if designRef}}**Design:** Read the architecture decisions at `{{designRef}}` — the design artifact is also available at `local://DESIGN.md`.{{/if}}

**Workflow slug:** `{{slug}}`

Your goals:
1. Execute the plan task by task:
   - Follow the TDD cycle (RED-GREEN-REFACTOR)
   - Use the agent tier specified in the plan
   - Dispatch independent tasks in parallel with `isolated: true`
   - Run two-stage review after each task (spec compliance, then code quality)
2. Update repo-wide documentation as part of the work:
   - Architecture docs in `docs/architecture/` (ADRs, component docs)
   - API documentation
   - Inline code comments for non-obvious logic
   - Module-level READMEs for new packages
3. Write a learnings/retrospective to `local://EXECUTE.md`. Include:
   - What was implemented and key decisions made
   - What went well (approaches, tools, patterns that helped)
   - What to improve (pain points, unexpected complexity)
   - Recommendations for future executions
4. When done, call `exit_plan_mode` with:
   - `title: "EXECUTE"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "execute"`

Do NOT skip tests. Do NOT skip reviews. The Iron Law applies.
