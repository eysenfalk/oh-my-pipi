Run the plan review workflow on `local://PLAN.md`. Your goal is to produce a plan that is ready for real implementation — no wrong assumptions, no over-engineering, no missing steps.

**Workflow (repeat up to 3 iterations):**

1. Read the full plan: `read` tool on `local://PLAN.md`
2. Spawn a `critic` agent via the `task` tool. In the context, include the complete plan text verbatim. The critic will evaluate it from red-team, pragmatic, and staff engineer perspectives and return a `verdict`, `issues`, and `suggested_revisions`.
3. If `verdict` is `needs_revision`:
   - Revise `local://PLAN.md` to address every issue in `issues`
   - Apply `suggested_revisions` where they are concrete and correct
   - Do not pad the plan — cut scope-creep, fix wrong assumptions, add missing steps
   - Go to step 1
4. If `verdict` is `approved`, or after 3 iterations (keep the best version):
   - Call `exit_plan_mode` with the plan title

**Revision discipline:**
- Fix substance, not prose. Each revision must address a specific issue the critic raised.
- If the critic flags an over-engineered section, simplify it — do not just acknowledge it.
- If the critic flags a wrong assumption, correct it against the actual codebase.
- Do not introduce new scope or new complexity during revision.

<critical>
You **MUST** keep going until the critic approves or 3 iterations complete. Do not call `exit_plan_mode` before the first critic review.
</critical>
