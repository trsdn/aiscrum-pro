# Contributing

Thank you for your interest in contributing! This guide covers setup, workflow, and conventions.

## Prerequisites

- **Node.js 20+**
- **npm** (comes with Node.js)

## Development Setup

```bash
# Clone and install
git clone https://github.com/trsdn/aiscrum-pro.git
cd aiscrum-pro
npm install
```

## Available Commands

```bash
npm test           # Run tests (vitest)
npm run lint       # Lint source and tests (eslint)
npm run build      # Build (tsc)
npm run typecheck  # Type-check without emitting
```

## Branch Naming

Use prefixed branch names based on the type of change:

| Prefix   | Use for                        |
|----------|--------------------------------|
| `feat/`  | New features                   |
| `fix/`   | Bug fixes                      |
| `docs/`  | Documentation changes          |
| `chore/` | Maintenance, tooling, configs  |

Example: `feat/42-add-search-endpoint`

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description> (#<issue>)
```

**Types**: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`

Examples:

```
feat(api): add user search endpoint (#42)
fix(auth): handle expired tokens (#15)
docs(readme): update setup instructions (#7)
```

## Workflow

1. Create a branch from `main` using the naming convention above
2. Make your changes — keep diffs small and focused
3. Run all checks before pushing:
   ```bash
   npm run lint && npm run typecheck && npm test
   ```
4. Push and open a pull request against `main`
5. Ensure CI passes before requesting review

## Code Style

- TypeScript with strict mode
- ESM modules with `.js` extensions on local imports
- Zod for runtime validation
- Keep code readable — avoid clever one-liners

## Tests

- Write tests for new features (minimum 3: happy path, edge case, parameter variation)
- Write a regression test for bug fixes
- Use [Vitest](https://vitest.dev/) as the test framework
