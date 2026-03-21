---
name: tdd
description: "Test-driven development with RED-GREEN-REFACTOR cycle, Iron Law enforcement, and rationalization prevention"
---

# TDD: Test-Driven Development

## Overview

Test-driven development is a disciplined workflow where tests guide implementation. Each production code change is preceded by a failing test that defines the desired behavior. This creates a living specification that prevents regression and forces explicit design decisions before implementation.

The TDD cycle has three phases: RED (write a failing test), GREEN (write minimal code to pass), REFACTOR (clean up while keeping tests green).

## When to Use

Use TDD when:
- Adding new functionality to an existing system
- Fixing bugs (write the failing test first to reproduce)
- Refactoring existing code (tests define the contract to preserve)
- Building new modules or services

## When to Skip

Exceptions where pure TDD may not apply:
- Spike solutions for exploring unknown territory
- One-off scripts or experiments
- Performance optimizations where tests would be noise
- Trivial code where test cost exceeds value (getters, simple mappings)

Even in these cases, consider: can a contract-level test prevent a future regression?

## The Iron Law

**No production code without a failing test first.**

This is non-negotiable. Before typing any implementation logic, write a test that exercises the desired behavior. The test must fail before you write the code.

Rationale:
- Tests written after implementation inevitably test what the code does, not what was needed
- The failing test defines the requirement precisely before you code yourself into a corner
- It forces separation of concerns: design the interface before implementing it

## The RED-GREEN-REFACTOR Cycle

### RED: Write One Minimal Failing Test

Write the smallest possible test that captures the next piece of behavior.

**Steps:**
1. Identify what external contract you need (not implementation details)
2. Write a test that exercises that contract
3. Run the test and confirm it fails with the expected error

**Good test example:**
```typescript
// GOOD: Tests contract, not implementation
test("parser returns error result for malformed JSON", () => {
  const result = parseJson("{ invalid }");
  expect(result.ok).toBe(false);
  expect(result.error).toBeDefined();
});
```

**Bad test example:**
```typescript
// BAD: Tests implementation details, not contract
test("parser throws SyntaxError for invalid JSON", () => {
  expect(() => parseJson("{ invalid }")).toThrow(SyntaxError);
});
```

The bad test assumes a specific error handling strategy (throwing). The good test only assumes the contract: malformed input yields an error result.

### Verify RED

Run: `bun test path/to/test.test.ts`

Confirm:
- Test fails with a clear, expected error
- Failure is in the test assertion, not due to missing imports or syntax errors
- The failure message explains what behavior is missing

If the test passes unexpectedly, you already have the behavior or your test is wrong.

### GREEN: Write Minimal Code to Pass

Write the simplest code that makes the test pass. No more, no less.

**Steps:**
1. Write only the code needed to pass this specific test
2. Do not anticipate future requirements
3. Do not refactor while in GREEN
4. Run tests and confirm they pass

**Good GREEN:**
```typescript
// Returns the minimal correct implementation
function parseJson(input: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}
```

**Bad GREEN:**
```typescript
// Over-engineered: adds validation, logging, retry logic before needed
async function parseJson(input: string): Promise<ParseResult> {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new EmptyInputError();
  const start = Date.now();
  try {
    const result = JSON.parse(trimmed);
    logger.info(`Parsed in ${Date.now() - start}ms`);
    return { ok: true, value: result, cached: false };
  } catch (e) {
    logger.error("Parse failed", { input: trimmed, error: e });
    throw new ParseError(e);
  }
}
```

### Verify GREEN

Run: `bun test path/to/test.test.ts`

Confirm:
- All tests pass
- No skipped tests
- No test isolation issues (tests pass in isolation and order)

### REFACTOR: Clean Up

Now that tests verify behavior, clean up the implementation.

**Steps:**
1. Improve code structure without changing behavior
2. Extract helpers, remove duplication, rename for clarity
3. Keep tests green throughout
4. If a refactor requires changing tests, do it in small steps

**Rules:**
- Never change test behavior during refactor
- If tests need updating to reflect new behavior, add new tests first
- Run tests after every significant change

## Pipi Testing Principles

From the coding agent guidelines:

### Contract-Level Tests Over Implementation Details

Test what callers depend on, not how you implemented it.

```typescript
// CONTRACT: parser returns structured result
// Implementation could be sync, async, streaming, cached...

// GOOD: Tests the contract
test("parseJson returns structured result", () => {
  const result = parseJson('{"key":"value"}');
  expect(result.ok).toBe(true);
  expect(result.value).toEqual({ key: "value" });
});

// BAD: Tests implementation
test("parseJson uses JSON.parse internally", () => {
  // This test knows too much about implementation
});
```

### No Mocks

Test real behavior. Mocks hide bugs that occur in production.

```typescript
// GOOD: Tests real file system behavior
test("loadConfig reads from config.json", async () => {
  const config = await loadConfig("./test-fixtures/valid-config.json");
  expect(config.port).toBe(3000);
});

// BAD: Tests with mock that might not match reality
test("loadConfig calls fs.readFile", async () => {
  const mockFs = { readFile: vi.fn().mockResolvedValue('{"port":3000}') };
  const config = await loadConfig("./config.json", mockFs);
  expect(mockFs.readFile).toHaveBeenCalled();
});
```

### No Placeholder Tests or Tautologies

Every test must defend one concrete, externally observable contract.

```typescript
// BAD: Tautology - always passes
test("parser works", () => {
  expect(parser).toBeDefined();
});

// BAD: Placeholder - tests nothing
test("parser parses", () => {
  const result = parse("test");
  // TODO: add assertions
});

// GOOD: Specific contract
test("parser returns error for empty string", () => {
  const result = parse("");
  expect(result.ok).toBe(false);
});
```

### No Duplicate Coverage at Abstraction Levels

Tests should not overlap in what they verify.

```typescript
// If you test parseJson handles empty string...
test("parseJson returns error for empty string", () => {
  expect(parseJson("").ok).toBe(false);
});

// ...you don't also need to test the JSON.parse call
// Both would be testing the same failure path through different lenses
```

## Why Order Matters

### Arguments Against TDD Order

**"But I know what the code should do - I don't need to write a test first."**

If you know what it should do, write it as a test. The test forces you to commit to the contract before you're deep in implementation and biased by what you built.

**"The test is obvious - I'll write it after to save time."**

Tests written after always test what you built, not what was needed. They provide false confidence. If it's too obvious to write, it's too obvious not to test - and the test might reveal non-obvious edge cases.

**"TDD slows me down."**

TDD adds ~20% upfront cost. It removes 80% of debugging time by catching mistakes at the boundary before they compound through layers of code.

**"The code is too complex to test without implementation."**

Complex code that can't be tested in isolation usually has a design problem. Write a test that captures the desired behavior and let it guide the interface design.

## Common Rationalizations

| Rationalization | Reality |
|----------------|---------|
| "I'll write the test after I understand the code" | You never do. After implementation, you test what you built, not what was needed. |
| "It's just a quick fix" | Quick fixes become permanent code. Test it or it will break again. |
| "The code is obvious" | If it's obvious, the test takes 30 seconds. If it's wrong, debugging takes hours. |
| "I need to understand the existing code first" | Write a test that documents your understanding. It doubles as verification. |
| "TDD is for junior developers" | Experts write tests because they know the cost of broken code. |
| "The test would be too hard to write" | Difficulty writing a test usually reveals a design problem. Fix the design. |
| "I'll test the happy path and move on" | Bugs live in edge cases. The happy path is where it works. |
| "We don't have time for tests" | You have time to write it twice. Once broken, once fixed. |
| "It's just a refactor" | Refactors break existing behavior. Tests prove behavior is preserved. |
| "I'll add tests in the next sprint" | Next sprint is never. Tests go in the same change that introduces the code. |
| "The integration test covers it" | Integration tests catch integration failures, not unit-level regressions. |
| "This code doesn't need tests" | Code that doesn't need tests doesn't need to exist. |

## Red Flags

Stop and re-evaluate if you see:
- Test files with more setup than assertions
- Tests that mock everything, including the system under test
- `test.skip`, `test.only`, or commented-out tests left behind
- Tests that only assert "no error thrown"
- Test names like `test1`, `test2`, `should work`
- Tests that pass but have no assertions
- Multiple tests asserting the same thing at different abstraction levels
- "This test was unreliable but passed on CI" - flakiness is a signal

## Bug Fix Example

### Scenario
Reports show users receiving wrong data when requesting non-existent records.

### TDD Approach

**Step 1: RED - Write failing test**
```typescript
// test/api/records.test.ts
test("getRecord returns null for non-existent ID", async () => {
  const result = await getRecord("non-existent-id");
  expect(result).toBeNull();
});
```

Run: `bun test test/api/records.test.ts`
- Failure: "Cannot read property 'id' of null" or similar crash
- This reproduces the bug

**Step 2: GREEN - Minimal fix**
```typescript
async function getRecord(id: string): Promise<Record | null> {
  const record = await db.records.findOne({ id });
  if (!record) return null;  // Add the missing null check
  return record;
}
```

Run: `bun test test/api/records.test.ts`
- Pass: Test confirms fix

**Step 3: REFACTOR**
- Verify other tests still pass
- Consider adding test for empty string ID edge case

## Verification Checklist

Before marking TDD work complete:

- [ ] Each new behavior has a corresponding failing test (RED first)
- [ ] Tests fail before implementation, pass after
- [ ] No mocks in tests (unless testing the mock itself)
- [ ] Tests verify contract, not implementation details
- [ ] No placeholder tests or skipped tests left behind
- [ ] Test names describe expected behavior
- [ ] All tests pass: `bun test`
- [ ] Type checking passes: `bun check` (if applicable)
- [ ] No test duplicates coverage across abstraction levels

## When Stuck

**Test fails but shouldn't:**
- Re-read the test - does it assert what you think?
- Is the implementation actually being called?
- Is there a caching or state issue between tests?

**Can't write a test:**
- The interface is unclear. Define the contract in a comment, then write the test.
- The design is wrong. Don't fight the test - let it guide the design.
- You're testing too much. One test, one assertion group.

**Test passes but shouldn't:**
- The implementation is correct by accident. Write another test that would fail if you remove the code.
- The test asserts too little. Add more specific assertions.

**Everything is hard to test:**
- Design problem signal. Extract pure functions, move side effects to boundaries.
- The code is doing too much. Each piece should be independently testable.

## Key Principles

1. **Test first, always.** The test defines the contract before implementation biases you.
2. **One test at a time.** Don't write all tests, then all code. Do RED-GREEN-REFACTOR in cycles.
3. **Minimal GREEN.** Write exactly enough to pass, not what you think should exist.
4. **Test contracts, not implementation.** If you could swap the implementation for a different one without changing the test, you're testing the right thing.
5. **No mocks.** Test the real behavior. Mocks hide integration bugs.
6. **Tests are documentation.** A new developer should understand the system from reading the tests.

---

See also: `skill://verification/SKILL.md` for post-implementation verification steps.
