.PHONY: install build lint typecheck test check dev start smoke factory-status factory-ready factory-prompt factory-validate
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
check:
	pnpm run check
dev:
	pnpm run dev
start:
	pnpm run start
smoke:
	pnpm run smoke
factory-status:
	python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . status
factory-ready:
	python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . ready
factory-prompt:
	@test -n "$(BATCH)" || (echo "Usage: make factory-prompt BATCH=B00" && exit 2)
	node tools/generate-batch-prompt.mjs --batch $(BATCH)
factory-validate:
	python3 .ai-life-time-machine/skill-package/scripts/validate_package.py --root .ai-life-time-machine/skill-package
