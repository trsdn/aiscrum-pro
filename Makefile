.PHONY: help check fix lint format typecheck test test-quick coverage build notify clean install test-setup test-cleanup test-web test-e2e

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# === Setup ===

install: ## Install dependencies
	npm install

setup: install ## Full setup (install + git hooks)
	./scripts/setup-hooks.sh

# === Quality ===

lint: ## Run linter
	npx eslint src/ tests/

format: ## Format code
	npx prettier --write 'src/**/*.ts' 'tests/**/*.ts'

fix: ## Auto-fix lint issues and format
	npx eslint src/ tests/ --fix
	npx prettier --write 'src/**/*.ts' 'tests/**/*.ts'

typecheck: ## Run type checker
	npx tsc --noEmit

check: lint typecheck test ## Run lint + types + tests

gate: ## Full gate: format + lint + types + tests + build (pre-push)
	npx prettier --check 'src/**/*.ts' 'tests/**/*.ts'
	npx eslint src/ tests/
	npx vitest run
	npx tsc && cd src/dashboard/frontend && npm run build

# === Build ===

build: ## Build TypeScript
	npx tsc

dev: ## Run in dev mode
	npx tsx src/index.ts

# === Testing ===

test: ## Run all tests
	npx vitest run

test-quick: ## Run tests with fast fail
	npx vitest run --bail 1

test-watch: ## Run tests in watch mode
	npx vitest

coverage: ## Run tests with coverage report
	npx vitest run --coverage

# === Notifications ===

notify: ## Send notification (MSG="your message")
	@if [ -n "$$NTFY_TOPIC" ]; then \
		curl -s -H "Title: $(or $(TITLE),Project Notification)" \
			-d "$(or $(MSG),Task completed)" \
			ntfy.sh/$$NTFY_TOPIC; \
		echo ""; \
	else \
		echo "NTFY_TOPIC not set. Run: export NTFY_TOPIC=your-topic"; \
	fi

# === Cleanup ===

clean: ## Remove build artifacts
	rm -rf dist/
	rm -rf coverage/ .vitest/

# === Test Sprint Runner ===

test-setup: ## Create test issues and milestones
	./scripts/test-setup.sh

test-cleanup: ## Remove all test sprint artifacts
	./scripts/test-cleanup.sh

test-web: ## Run web dashboard in test mode
	npx tsx src/index.ts web --config .aiscrum/config.test.yaml

test-e2e: ## Run Playwright E2E tests (requires test-setup first)
	npx playwright test --reporter=list
