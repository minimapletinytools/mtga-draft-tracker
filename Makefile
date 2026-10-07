.DEFAULT_GOAL := run

.PHONY: install build run dev test typecheck check clean icons fixture screenshots help

install: ## Install dependencies
	pnpm install

build: ## Build every package and the desktop bundle
	pnpm build

run: build ## Build, then launch the Electron app
	pnpm --filter @drafttracker/desktop start

dev: ## Run the UI in a browser against the bundled sample draft
	pnpm --filter @drafttracker/web dev

test: ## Run the test suite
	pnpm test

typecheck: ## Typecheck every package
	pnpm typecheck

check: typecheck test ## Typecheck and test, without building

clean: ## Remove all build output
	@test -f package.json && test -f pnpm-workspace.yaml \
		|| { echo "clean: run this from the repository root" >&2; exit 1; }
	rm -rf packages/core/dist packages/arena/dist packages/cards/dist
	rm -rf apps/web/dist apps/desktop/dist apps/desktop/release

icons: ## Redraw the app icons
	python3 apps/desktop/scripts/make-icons.py

fixture: build ## Regenerate the browser-mode sample draft from a real log
	node apps/desktop/scripts/make-dev-fixture.mjs

screenshots: build ## Render the UI in Electron and write PNGs to .screenshots/
	node apps/desktop/scripts/screenshot.mjs

help: ## List these targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'
