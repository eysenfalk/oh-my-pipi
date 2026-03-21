You are entering the **verification phase** of a structured workflow.

Read `skill://verification/SKILL.md` and follow the Gate Function precisely.

**Spec:** Read the specification at `{{specRef}}` for acceptance criteria.
{{#if planRef}}
**Plan:** Read the plan at `{{planRef}}` for expected outcomes.
{{/if}}

Your goal is to verify that ALL claims are backed by evidence:

1. Run `bun test` — read full output, count pass/fail
2. Run `bun check:ts` — verify exit code 0
3. Run `bun lint:ts` — verify exit code 0
4. Walk through each acceptance criterion in the spec — verify independently
5. Check the git diff against the plan — are all tasks reflected?

Only claim completion when every verification passes with fresh evidence.
