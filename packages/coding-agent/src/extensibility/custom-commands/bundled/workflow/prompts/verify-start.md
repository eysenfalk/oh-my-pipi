You are entering the **verification phase** of a structured workflow.

Read `skill://verification/SKILL.md` and follow the Gate Function precisely.

**Spec:** Read the specification at `{{specRef}}` for acceptance criteria.
{{#if planRef}}
**Plan:** Read the plan at `{{planRef}}` for expected outcomes.
{{/if}}

**Workflow slug:** `{{slug}}`

Your goals:
1. Verify all claims with fresh evidence:
   - Run the project's test suite — read full output, count pass/fail
   - Run the project's type checker — verify exit code 0
   - Run the project's linter — verify exit code 0
   - Check `AGENTS.md`, `package.json`, or `Makefile` for the correct commands. Do not assume a specific runtime.
   - Walk through each acceptance criterion in the spec — verify independently
   - Check the git diff against the plan — are all tasks reflected?
2. Update test documentation:
   - Test plans and coverage notes in `docs/test/`
   - QA runbooks for complex scenarios
3. Write verification findings to `local://VERIFY.md`. Include:
   - Test results with exact counts
   - Each acceptance criterion: PASS/FAIL with evidence
   - Any gaps or deviations found
   - **Learnings section**: what the verification revealed, testing improvements needed
4. When done, call `exit_plan_mode` with:
   - `title: "VERIFY"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "verify"`

Only claim completion when every verification passes with fresh evidence.
