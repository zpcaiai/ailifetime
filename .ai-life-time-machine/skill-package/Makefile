.PHONY: validate test doctor list profiles backlog checksums
validate:
	python3 scripts/validate_package.py --root .
test:
	python3 -m unittest discover -s tests -v
doctor:
	python3 scripts/doctor.py --root .
list:
	python3 scripts/list_batches.py
profiles:
	python3 scripts/projectctl.py --repo . profile-list
backlog:
	python3 scripts/render_backlog.py --profile full-commercial --output FULL_COMMERCIAL_BACKLOG.md
checksums:
	python3 scripts/generate_checksums.py
