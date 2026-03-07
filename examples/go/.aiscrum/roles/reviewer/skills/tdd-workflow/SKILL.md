---
name: tdd-workflow
description: Test-Driven Development cycle for writing tests before implementation.
---

## When to Use

- Writing tests before implementation code
- Verifying a bug fix with regression test (red → green)
- Checking test coverage

## Steps

1. Write test first — based on acceptance criteria
2. Run tests — verify they FAIL (red phase)
3. Implement — write minimal code to make tests pass (green phase)
4. Refactor — clean up while keeping tests green
5. Check coverage — ensure new code is covered

## Verify

- Tests should fail before implementation exists
- Tests should pass after implementation
- Coverage should not decrease
