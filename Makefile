.PHONY: install build lint typecheck test test-infra check dev start smoke factory-status factory-ready factory-prompt factory-validate
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
dev:
	pnpm run dev
start:
	pnpm run start
smoke:
	pnpm run smoke
factory-status:
	pnpm run factory:status
factory-ready:
	pnpm run factory:ready
factory-prompt:
	@test -n "$(BATCH)" || (echo "Usage: make factory-prompt BATCH=B00" && exit 2)
	node tools/generate-batch-prompt.mjs --batch $(BATCH)
factory-validate:
	python3 .ai-life-time-machine/skill-package/scripts/validate_package.py --root .ai-life-time-machine/skill-package
