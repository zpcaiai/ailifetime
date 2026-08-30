.PHONY: install build lint typecheck test test-infra check contracts seed-local dev start local-up local-down smoke baseline baseline-verify factory-status factory-ready factory-prompt factory-validate
install:
	pnpm install --frozen-lockfile
build:
	pnpm run build
lint:
	pnpm run lint
typecheck:
	pnpm run typecheck
test:
	pnpm run test
test-infra:
	pnpm run test:infra
check:
	pnpm run check
contracts:
	pnpm run contracts:generate
seed-local:
	pnpm run seed:local
dev:
	pnpm run dev
start:
	pnpm run start
local-up:
	pnpm run local:up
local-down:
	pnpm run local:down
smoke:
	pnpm run smoke
baseline:
	pnpm run baseline:inspect
baseline-verify:
	pnpm run baseline:verify
factory-status:
	pnpm run factory:status
factory-ready:
	pnpm run factory:ready
factory-prompt:
	@test -n "$(BATCH)" || (echo "Usage: make factory-prompt BATCH=B00" && exit 2)
	node tools/generate-batch-prompt.mjs --batch $(BATCH)
factory-validate:
	python3 .ai-life-time-machine/skill-package/scripts/validate_package.py --root .ai-life-time-machine/skill-package
