---
name: architecture
description: "Produce agent-consumable architecture documents for large features, new subsystems, and significant refactors"
---

# Architecture Skill

## Overview

Architecture documents are instructions for the agent that will implement the code. They must be precise, parseable, and actionable — not prose summaries for human readers. The test of a good architecture doc is whether an agent can read it and produce correct code without asking clarifying questions.

## When to Use

Dispatch this skill before implementation when the change involves:

- 10 or more files
- A new subsystem or top-level package
- A significant refactor that changes component boundaries
- Cross-cutting concerns (auth, caching, error propagation, persistence)
- Any feature where multiple agents would need to coordinate

Do not write an architecture doc for a 3-file feature with straightforward logic. Use judgment.

## Design Document Format

Every architecture doc lives at `docs/workflow/<slug>/design.md`. Use the slug format `YYYY-MM-DD-<topic>` (e.g., `2026-03-21-auth-redesign`).

```markdown
# [Feature] Architecture

## File Map
- CREATE: `src/path/new-file.ts` — [one-sentence responsibility]
- MODIFY: `src/path/existing.ts` — [what changes and why]
- DELETE: `src/path/old-file.ts` — [why it is being removed]
- TEST: `src/path/test.test.ts` — [what it tests]

## Interface Contracts

```typescript
// Shared types that components import from each other
interface InputShape { ... }
interface OutputShape { ... }
// What errors each function returns and what they mean
```

## Data Flow

For each major operation:

1. **Entry**: Who calls it, what they pass, what they expect
2. **Validation**: Exact rules — what is rejected, with what error
3. **Transform**: Step-by-step through each layer
4. **Persistence**: What is written, where, and when
5. **Output**: What the caller receives on success

## Component Responsibilities

For each component:

- **Does**: specific, enumerated behaviors
- **Does NOT do**: explicit exclusions that callers might assume belong here
- **Errors**: which errors it throws and when

## Dependencies

Build a dependency table or list:

- `module-a.ts` imports `module-b.ts`
- `module-b.ts` imports `module-c.ts`
- No circular dependencies. If cycles exist, document why and the mitigation.

## Error Handling

- **Propagation**: Which errors propagate to callers vs. are caught internally
- **Shape**: What callers see — typed error types, not generic `Error`
- **Recovery**: What a caller can do when each error occurs
```

## Principles

### Agent-Consumable

Every statement must be specific enough to implement without interpretation.

| Vague | Precise |
|-------|---------|
| "add validation" | "reject if `name` is empty or longer than 100 chars, return `ValidationError` with field `name`" |
| "the service handles X" | "ServiceX validates input, then calls RepositoryY.insert(), throws `DuplicateKeyError` on conflict" |
| "module Z manages state" | "ModuleZ maintains an in-memory Map<id, State>, expires entries after 5 minutes, does not persist" |

### Interface-First

Define what components share before describing how they work internally. Types, function signatures, and error shapes come first. Implementation details follow.

### Dependency Direction

Dependencies flow inward: high-level policies depend on low-level details, not the reverse. Document the direction explicitly. If a dependency graph would be cyclic, surface this as a problem to solve before implementation, not a note to file.

### No Hand-Waving

If a step cannot be written as a precise instruction, it is not designed. Return to the drawing board until every step is concrete.

## Anti-Patterns

**Box-and-arrow diagrams without interface contracts.** A diagram showing boxes connected by arrows is not architecture. It tells the implementing agent nothing about what data crosses each boundary.

**"The service handles X."** This phrase hides a design decision. Specify exactly what handling means: which inputs, what outputs, what errors.

**Missing error handling strategy.** Every function that can fail must document what it returns on failure and why. Silent failures, swallowed errors, and unspecified error shapes are not acceptable.

**Circular dependencies.** If component A imports B and B imports A, the architecture doc must explicitly identify this and specify the refactoring strategy to break the cycle.

**Generic types.** `interface Config { ... }` with no fields specified is not a contract. Write the fields.

**Implausible timelines.** Architecture docs sometimes include implementation estimates. These are noise unless backed by explicit file counts and known per-file complexity.

## Review Process

After drafting the architecture doc:

1. Dispatch the `critic` agent to evaluate:
   - Are all file paths concrete and correct?
   - Are all interface contracts typed?
   - Is every data flow step traceable from input to output?
   - Are error cases specified for every operation?
   - Are there any circular dependencies?
2. Address all critic findings.
3. Repeat up to 3 iterations. If not resolved by iteration 3, escalate to the delegating agent with a specific list of unresolved questions.

```bash
# Example: dispatch critic on a design doc
task agent:critic "Review docs/workflow/2026-03-21-feature-x/design.md for completeness"
```

## Common Mistakes

- Writing architecture as a narrative instead of a specification
- Omitting the `DELETE` entries from the file map when refactoring
- Listing what a component does without listing what it explicitly does NOT do
- Forgetting to specify error shapes — every function that can fail needs a documented error type
- Assuming the next agent will know project conventions — spell them out explicitly
- Skipping the dependency graph when the feature touches existing modules

## Artifact Location

Write completed design documents to:

```
docs/workflow/<slug>/design.md
```

Use the slug format `YYYY-MM-DD-<topic>`. This location is the canonical reference for the implementation phase. If multiple agents will work from this doc, ensure it is stable before dispatching them.
