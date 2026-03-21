---
name: workflow
description: "Multi-phase development workflow — phase selection, modes, and artifact conventions"
alwaysApply: true
---

# Development Workflow

Multi-phase workflow for structured development. Phases scale to change complexity.

## Phases

```
brainstorm --> spec --> design --> plan --> execute --> verify --> finish
 (optional)   (opt)   (opt)    (core)   (core)     (core)   (opt)
```

## Phase Selection

| Change Size | Phases | Example |
|---|---|---|
| Quick fix (1-10 lines) | Direct edit, no workflow | Typo, one-line bug |
| Small feature (1-3 files) | plan --> execute --> verify | Add a CLI flag |
| Medium feature (3-10 files) | spec --> plan --> execute --> verify | New tool, refactor |
| Large feature (10+ files) | brainstorm --> spec --> design --> plan --> execute --> verify --> finish | New subsystem |
| Research / exploration | brainstorm only | "How should we approach X?" |

## Modes

| Mode | Gate | After Gate |
|---|---|---|
| `/plan` | Human approves **each** planning phase | Human-guided throughout |
| `/auto` | Human approves **first** planning phase for task size | Autonomous with critic review (max 3 iterations per phase) |
| No command | Direct work | No phase structure |

**`/auto` gate by size:**
- Small: human approves **plan** --> auto execute --> verify
- Medium: human approves **spec** --> auto plan --> execute --> verify
- Large: human approves **brainstorm** --> auto spec --> design --> plan --> execute --> verify --> finish

## Artifacts

All artifacts live in the project repo at `docs/workflow/<slug>/`:
- **Slug format**: `YYYY-MM-DD-<topic>` (e.g., `2026-03-21-auth-redesign`)
- Each phase writes: `docs/workflow/<slug>/<phase>.md`
- State tracked in: `docs/workflow/<slug>/state.json`
- Plan file: `local://PLAN.md` (existing convention, committed on approval)

## Phase Transitions

When completing a phase:
1. Write phase artifact to `docs/workflow/<slug>/<phase>.md`
2. Update `state.json` with current phase and artifact paths
3. In `/plan` mode: present artifact for user approval before advancing
4. In `/auto` mode (after human gate): dispatch critic agent for review, advance on approval

## Skill Reference

| Phase | Skill |
|---|---|
| Brainstorm | `skill://brainstorming/SKILL.md` |
| Spec | `skill://spec-writing/SKILL.md` |
| Design | `skill://architecture/SKILL.md` |
| Plan | `skill://planning/SKILL.md` |
| Execute | `skill://tdd/SKILL.md` + `skill://agent-orchestration/SKILL.md` |
| Verify | `skill://verification/SKILL.md` |
| Finish | `skill://finishing/SKILL.md` |

## Rules

- **No implementation before plan approval.** Even "simple" changes benefit from a plan when they touch 2+ files.
- **Fresh context per phase.** Each phase starts with a clean session. Prior work is available only through artifacts.
- **Evidence before claims.** Read `skill://verification/SKILL.md` before claiming any phase is complete.
- **Failure stops propagation.** If any phase fails after max retries, stop and report with the last artifact state. Do not push garbage forward.
