---
name: brainstorming
description: "Explore intent, requirements, and design before implementation. Use before any creative work — new features, architecture changes, system design."
---

# Brainstorming Ideas Into Designs

Turn ideas into fully formed designs through collaborative dialogue. Start by understanding the project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

Complete in order:

1. **Explore project context** — check files, docs, recent commits
2. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to complexity, get user approval after each section
5. **Write design doc** — save to `docs/workflow/<slug>/brainstorm.md` and commit
6. **Critic review loop** — dispatch `critic` agent to review the design doc; fix issues and re-dispatch until approved (max 3 iterations, then surface to human)
7. **User reviews written doc** — ask user to review the artifact before proceeding
8. **Transition to planning** — read `skill://planning/SKILL.md` to create the implementation plan

## Process Details

### Understanding the Idea

- Check the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems, flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects. Each sub-project gets its own spec --> plan --> implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea.
- Prefer multiple choice questions when possible. Open-ended is fine too.
- **One question per message.** If a topic needs more exploration, break it into multiple questions.
- Focus on understanding: purpose, constraints, success criteria.

### Exploring Approaches

- Propose 2-3 different approaches with trade-offs.
- Lead with your recommended option and explain why.
- Present options conversationally with clear reasoning.

### Presenting the Design

- Once you believe you understand what you're building, present the design.
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced.
- Ask after each section whether it looks right so far.
- Cover: architecture, components, data flow, error handling, testing strategy.
- Be ready to go back and clarify if something doesn't make sense.

## Design Principles

### Design for Isolation and Clarity

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently.
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are easier to work with — the agent reasons better about code it can hold in context at once, and edits are more reliable when files are focused.

### Working in Existing Codebases

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

### Write the Design Doc

- Write the validated design to `docs/workflow/<slug>/brainstorm.md`
- Use clear, concise technical prose
- Commit the design document to git

### Critic Review Loop

After writing the design doc:

1. Dispatch `critic` agent with the design doc path and the original user request
2. If issues found: fix them, re-dispatch critic, repeat
3. If loop exceeds 3 iterations: surface to human for guidance
4. If approved: proceed to user review

### User Review Gate

After the critic review loop passes, ask the user to review the written design:

> "Design written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the critic review loop. Only proceed once the user approves.

### Transition to Planning

- Read `skill://planning/SKILL.md` to create a detailed implementation plan.
- Do NOT start implementing. Planning is the next step.

## Key Principles

- **One question at a time** — Don't overwhelm with multiple questions
- **Multiple choice preferred** — Easier to answer than open-ended when possible
- **YAGNI ruthlessly** — Remove unnecessary features from all designs
- **Explore alternatives** — Always propose 2-3 approaches before settling
- **Incremental validation** — Present design, get approval before moving on
- **No implementation without approval** — The hard gate is non-negotiable

## Red Flags

- Starting to write code before design is approved
- Skipping the critic review loop
- Combining multiple questions into one message
- Proposing only one approach (always offer alternatives)
- Ignoring existing codebase patterns
- Designing components that can't be tested independently
- Scope creeping during design (add to non-goals instead)
