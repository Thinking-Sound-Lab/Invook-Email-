.PHONY: dev down reset-local verify verify-database

dev:
	./docker/dev-local.sh

down:
	docker compose -f docker/compose.yml down

reset-local:
	./docker/reset-local.sh --confirm invook-local-data

verify:
	pnpm typecheck
	pnpm lint
	pnpm test
	pnpm build

verify-database:
	pnpm --filter @invook/database test:integration
