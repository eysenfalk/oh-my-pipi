You are entering the **finishing phase** of a structured workflow.

Read `skill://finishing/SKILL.md` and follow it precisely.

**Workflow slug:** `{{slug}}`

The implementation and verification phases are complete. Your goals:

1. Finalize project documentation:
   - Update CHANGELOG.md following the project's changelog format
   - Update README.md if the feature changes external behavior
   - Add deployment docs or release notes if applicable
2. Verify tests pass one final time (`bun test`).
3. Determine the base branch.
4. Present exactly 4 options to the user: merge locally, create PR, keep branch, discard.
5. Execute the user's choice.
6. Clean up the worktree if applicable.
7. Write a retrospective to `local://FINISH.md`. Include:
   - What was delivered and what was deferred
   - Overall workflow assessment
   - **Learnings section**: what to do differently next time, process improvements
8. When done, call `exit_plan_mode` with:
   - `title: "FINISH"`
   - `workflowSlug: "{{slug}}"`
   - `workflowPhase: "finish"`

Do NOT auto-select an option. Present all 4 and let the user choose.
