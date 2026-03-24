You are entering the **spec phase** of a structured workflow.

Read `skill://spec-writing/SKILL.md` and follow it precisely.

{{#if brainstormRef}}
**Prior brainstorm:** Read the document at `{{brainstormRef}}` for context.
{{/if}}

**Workflow slug:** `{{slug}}`

Your goals:
1. Produce a formal specification with RFC 2119 requirements and WHEN/THEN acceptance criteria.
2. Write the spec to `local://SPEC.md`. Include:
   - Functional requirements (MUST/SHOULD/MAY)
   - Acceptance criteria (WHEN/THEN)
   - Non-goals and constraints
   - Interface contracts where applicable
   - **Learnings section**: what you clarified, ambiguities resolved, open questions remaining
3. Update any existing spec documents in `docs/` if they exist and are relevant.
4. When done, call `exit_plan_mode` with:
   - `title: "SPEC"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "spec"`

Do NOT implement. Do NOT plan tasks. Write the spec only.
