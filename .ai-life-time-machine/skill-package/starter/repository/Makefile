.PHONY: factory-status factory-ready factory-prompt factory-validate
factory-status:
	python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . status
factory-ready:
	python3 .ai-life-time-machine/skill-package/scripts/projectctl.py --repo . ready
factory-prompt:
	@test -n "$(BATCH)" || (echo "Usage: make factory-prompt BATCH=B00" && exit 2)
	python3 .ai-life-time-machine/skill-package/scripts/generate_batch_prompt.py --repo . --batch $(BATCH)
factory-validate:
	python3 .ai-life-time-machine/skill-package/scripts/validate_package.py --root .ai-life-time-machine/skill-package
