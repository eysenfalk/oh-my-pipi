You are entering the **execution phase** of a structured workflow.

Read `skill://tdd/SKILL.md` for the TDD process.
Read `skill://agent-orchestration/SKILL.md` for subagent dispatch patterns.

**Plan:** Read the implementation plan at `{{planRef}}`.
**Spec:** Read the specification at `{{specRef}}` for acceptance criteria.

Execute the plan task by task. For each task:
1. Follow the TDD cycle (RED-GREEN-REFACTOR)
2. Use the agent tier specified in the plan
3. Dispatch independent tasks in parallel with `isolated: true`
4. Run two-stage review after each task (spec compliance, then code quality)

Do NOT skip tests. Do NOT skip reviews. The Iron Law applies.
