---
name: planning
description: "Decompose specs into ordered, bite-sized implementation tasks with TDD steps, exact file paths, agent tier selection, and parallelism annotations."
---

# Writing Implementation Plans

## Overview

Write comprehensive implementation plans assuming the implementing agent has **zero context** for the codebase. Document everything: which files to touch, complete code, how to test, exact commands with expected output. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume the implementer is a skilled developer but knows nothing about the toolset or problem domain. Assume they don't know good test design.

**Save plans to:** `docs/workflow/<slug>/plan.md`

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-specs during brainstorming. If it wasn't, suggest breaking into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

**Break signal:** If you find yourself writing tasks that could each be a plan, the spec is too broad.

## File Structure Map

Before defining tasks, map out which files will be created or modified and what each one is responsible for.

```markdown
## File Map
- CREATE: `src/workflow/engine.ts` — Phase transition logic
- CREATE: `src/workflow/artifacts.ts` — Read/write workflow artifacts
- MODIFY: `src/commands/plan.ts` — Add multi-phase support
- DELETE: `src/legacy/old-plan.ts` — Replaced by workflow engine
- TEST: `test/workflow/engine.test.ts` — Phase transition tests
- TEST: `test/workflow/artifacts.test.ts` — Artifact I/O tests
```

**Principles:**
- Each file has one clear responsibility
- Files that change together should live together
- Split by responsibility, not by technical layer
- Follow existing codebase patterns
- Prefer smaller, focused files over large ones

## Task Structure

````markdown
### Task N: [Component Name]

**Agent tier:** `task` | `quick_task` | `senior_task`
**Parallel group:** A | B | sequential
**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts`
- Test: `test/exact/path/to/test.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test";

test("specific behavior", () => {
    const result = functionUnderTest(input);
    expect(result).toBe(expected);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/exact/path/to/test.test.ts`
Expected: FAIL with "functionUnderTest is not defined"

- [ ] **Step 3: Write minimal implementation**

```typescript
export function functionUnderTest(input: Input): Output {
    return expected;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/exact/path/to/test.test.ts`
Expected: PASS (all green)

- [ ] **Step 5: Commit**

```bash
git add test/exact/path/to/test.test.ts src/exact/path/to/file.ts
git commit -m "feat: add specific feature"
```
````

**Each step is one action (2-5 minutes).** "Write test + implement + verify" is three steps, not one.

## Agent Tier Selection

Match task complexity to the right agent tier:

| Complexity Signal | Agent Tier | Examples |
|---|---|---|
| Single file, clear spec, mechanical | `quick_task` | Rename exports, add a type, boilerplate |
| 1-3 files, well-specified, TDD steps provided | `task` | Implement a function, add a CLI flag |
| Multi-file, moderate integration | `mid_task` | Wire components together, refactor module |
| Complex reasoning, architecture judgment, broad codebase | `senior_task` | Design decision in code, cross-cutting refactor |

**Default to `task`.** Use `quick_task` only for truly mechanical work. Use `senior_task` only when the task requires judgment the plan can't fully specify.

## Parallelism Annotations

Mark which tasks can run concurrently:

```markdown
## Execution Order

### Parallel Group A (independent, dispatch with `isolated: true`)
- Task 1: Parser module
- Task 2: Formatter module
- Task 3: Config schema

### Sequential (depends on Group A)
- Task 4: Integration wiring (imports from Tasks 1-3)
- Task 5: CLI entry point (imports from Task 4)
```

**Rules:**
- Tasks in the same parallel group MUST NOT touch overlapping files
- Tasks in the same parallel group MUST NOT have data dependencies
- If you can't prove independence, make them sequential
- Use `isolated: true` on task dispatch for parallel groups (worktree isolation)

## Plan Document Header

Every plan MUST start with:

```markdown
# [Feature Name] Implementation Plan

> **For execution:** Read `skill://agent-orchestration/SKILL.md` (recommended: subagent-driven)
> or execute tasks inline following `skill://tdd/SKILL.md`.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** `docs/workflow/<slug>/spec.md`

---
```

## Plan Review Loop

After writing the complete plan:

1. Dispatch `critic` agent with the plan file path and spec file path
2. Critic checks:
   - Complete file paths for every task?
   - Testable TDD steps with exact commands?
   - DRY / YAGNI compliance?
   - Correct dependency ordering?
   - Agent tier appropriate for each task?
   - Parallel groups truly independent?
3. If issues found: fix and re-dispatch (max 3 iterations, same agent fixes — preserves context)
4. If approved: proceed to execution handoff

## Execution Handoff

After saving and reviewing the plan:

> "Plan complete and saved to `docs/workflow/<slug>/plan.md`. Two execution options:
>
> **1. Subagent-Driven (recommended)** — Fresh subagent per task via `task` tool, two-stage review between tasks. Read `skill://agent-orchestration/SKILL.md`.
>
> **2. Inline Execution** — Execute tasks in this session following `skill://tdd/SKILL.md`, batch with checkpoints for review.
>
> Which approach?"

## Common Mistakes

| Mistake | Fix |
|---|---|
| "Add validation" without specifying what | Complete code in plan — what validates what, what error on failure |
| Missing test file paths | Every task needs a `Test:` path |
| No expected output for test commands | Always include expected PASS/FAIL with reason |
| Steps too coarse ("implement the feature") | Each step is one action: write test, run test, write code, run test, commit |
| Wrong agent tier (senior_task for boilerplate) | Match complexity signals to tier table |
| Parallel tasks sharing files | Verify file lists don't overlap before marking parallel |

## Reference Skills

- `skill://tdd/SKILL.md` — RED-GREEN-REFACTOR cycle for each task
- `skill://agent-orchestration/SKILL.md` — Subagent dispatch and review for execution
- `skill://verification/SKILL.md` — Evidence-before-claims for task completion
