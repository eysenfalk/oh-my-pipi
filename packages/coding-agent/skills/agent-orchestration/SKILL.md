---
name: agent-orchestration
description: "Coordinate parallel agent swarms with intelligent tier selection and two-stage review"
---

# Agent Orchestration

## Overview

Orchestration is the discipline of decomposing multi-phase work into isolated, parallelizable tasks and coordinating them through the correct agent tier. The goal is not to maximize parallelism but to minimize latency while guaranteeing correctness through structured review.

The key insight: most workflow failures are orchestration failures, not implementation failures. The agent picked the wrong tier, skipped isolation, or proceeded without passing review.

## When to Use

You are orchestrating when:
- A plan has 2+ implementation tasks
- Tasks can be executed independently
- Multiple agent tiers are needed in sequence
- Review gates are required before proceeding

You are NOT orchestrating when:
- Single agent completes all work in one session
- Tasks have hard sequential dependencies (B uses A's output)
- No review or verification is planned

## Agent Tier Selection

Choose the tier that matches task complexity, not agent preference.

| Complexity Signals | Tier | When to Use |
|-------------------|------|-------------|
| Single file, mechanical change, clear spec | `quick_task` | Renames, pattern application, wrapper insertion |
| 1-3 files, well-specified, predictable shape | `task` | Standard features, straightforward refactors |
| 4+ files, moderate scope, some unknowns | `mid_task` | Multi-file features with cross-cutting concerns |
| Architecture decision, boundary change, high stakes | `senior_task` | Core system changes, design tradeoffs |
| Spec compliance verification | `reviewer` | Plan-to-code alignment checks |
| Code quality, convention adherence, security | `critic` | Second-pass review after reviewer passes |
| Dead ends, impossible bugs, design dilemmas | `oracle` | Debugging blockers, architectural second opinions |

**Rule:** When uncertain, use a more capable tier. Under-tiering produces failures that require rework and escalation.

## Swarm Dispatch Patterns

### Parallel Dispatch (3+ Independent Tasks)

```
┌─────────────────────────────────────────┐
│  Plan with N independent tasks          │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼         ▼        ▼
     [task]    [task]   [task]
    isolated  isolated  isolated
        │         │        │
        └────┬────┴────────┘
             ▼
        [reviewer]  (sequential on results)
             │
             ▼
         [critic]   (sequential on reviewer output)
             │
             ▼
         Complete or Escalate
```

**Rule:** Only parallelize tasks that do NOT touch overlapping files. The `isolated: true` flag provides worktree isolation -- use it.

**Validation before dispatch:**
1. Each task has a clear acceptance criterion
2. No task reads outputs from another task
3. Tasks operate on disjoint file sets OR use `isolated: true`
4. Annotate file independence in the plan

### Sequential Dispatch

Tasks that share files or data dependencies must run sequentially.

```
[task A] → [task B] → [task C]
```

Sequential is correct when:
- B reads A's output files
- B and A modify the same module
- The plan explicitly sequences them

### Dependency Chain for 2 Tasks

When only 2 tasks exist and one depends on the other:
1. Run the independent task first
2. Feed its artifacts into the dependent task's context
3. Then run the dependent task

## Two-Stage Review Process

Stage 1 and Stage 2 must both pass. Skipping either stage is a red flag.

### Stage 1: Spec Compliance (reviewer)

**Goal:** Does the code match the plan?

Questions:
- Are all specified files touched?
- Are all specified behaviors implemented?
- Are all specified edge cases handled?
- Are no unspecified behaviors added?

**Tool:** Dispatch `reviewer` agent with:
- Plan artifact or spec reference
- Acceptance criteria
- Files to verify

### Stage 2: Code Quality (critic)

**Goal:** Does the code meet project standards?

Questions:
- Does it follow existing conventions?
- Are types correct and complete?
- Are errors handled properly?
- Are there obvious bugs or security issues?

**Tool:** Dispatch `critic` agent with:
- Code artifact reference
- Project conventions (from codebase patterns)
- Security/reliability checklist

**Order matters:** Always run reviewer first. Code that fails spec compliance does not need quality review.

## Implementer Status Handling

Agents report one of four statuses:

| Status | Meaning | Action |
|--------|---------|--------|
| `DONE` | Task complete, ready for review | Proceed to review |
| `DONE_WITH_CONCERNS` | Complete but has issues | Note concerns, proceed to review |
| `NEEDS_CONTEXT` | Cannot proceed without more info | Provide context or escalate |
| `BLOCKED` | External blocker | Surface to human immediately |

**`DONE_WITH_CONCERNS` is acceptable** if concerns are logged and addressed in review. It is NOT acceptable to ignore them.

**`NEEDS_CONTEXT` and `BLOCKED` require action** before proceeding. Never continue past these statuses.

## Failure Handling and Escalation

### The 2-Fix Rule

Per task, per phase:
1. **Attempt 1:** Dispatch agent, inspect result
2. **Attempt 2:** If failed, provide error output + guidance, dispatch again
3. **Escalate:** If Attempt 2 fails, do NOT retry without changes

**Never force-retry identical work.** Each retry must incorporate new information.

### Escalation Ladder

When a task fails after 2 attempts, climb the ladder:

```
Level 1: More context
  → Gather error output, compiler messages, test failures
  → Add to task assignment
  → Retry with same tier

Level 2: More capable tier
  → Same work, senior_task instead of mid_task
  → More reasoning capacity for complex problems

Level 3: Break into smaller tasks
  → Split the failing task into 2+ smaller tasks
  → Distribute to different agents
  → Re-coordinate

Level 4: Surface to human
  → The problem requires human judgment
  → Document what was tried, what failed, what the blocker is
  → Use exit_plan_mode or direct escalation
```

## File Conflict Prevention

**Primary mechanism:** `isolated: true` in task dispatch. This spins up an isolated worktree per agent.

When NOT using isolation (discouraged):
- Explicitly verify file sets are disjoint
- Document file ownership in the plan
- Run tasks sequentially if any doubt

**Warning:** Overlapping file access without isolation produces merge conflicts and silent data corruption.

## Example Workflow

```
1. Plan exists: local://PLAN.md with 5 tasks

2. Analyze dependencies:
   - Tasks 1, 2, 3: independent (disjoint files)
   - Task 4: depends on Tasks 1, 2
   - Task 5: independent

3. Phase 1: Parallel dispatch
   task(id="task1", isolated=true, ...)
   task(id="task2", isolated=true, ...)
   task(id="task3", isolated=true, ...)

4. Review Phase 1
   reviewer agent: verify Tasks 1-3 spec compliance
   critic agent: verify Tasks 1-3 code quality

5. Phase 2: Sequential (Tasks 4, 5 in parallel)
   task(id="task4", isolated=true, ...)  # uses Task 1-2 artifacts
   task(id="task5", isolated=true, ...)

6. Review Phase 2
   reviewer agent: verify Tasks 4-5 spec compliance
   critic agent: verify Tasks 4-5 code quality

7. Complete or escalate any failed tasks
```

## Red Flags

**Skip reviews:**
- Proceeding past implementation without reviewer + critic pass
- Marking tasks complete without verification
- Trusting agent self-assessment without review

**Parallel without isolation:**
- `isolated: false` with overlapping file targets
- Assumed independence without verification
- Undocumented shared state between tasks

**Proceed with unfixed issues:**
- `DONE_WITH_CONCERNS` with unaddressed concerns
- Reviewer findings ignored
- Compiler errors accepted without fix

**Ignore escalation:**
- Third retry without new information
- Continuing past `BLOCKED` status
- Forcing completion against agent judgment
