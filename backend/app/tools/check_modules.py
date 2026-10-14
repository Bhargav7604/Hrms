"""Validate every module definition and report coverage of the 80 proposal modules.

    uv run python -m app.tools.check_modules            # all modules
    uv run python -m app.tools.check_modules --ignore-missing-refs
"""

from __future__ import annotations

import sys

from app.core.registry import all_entities, load_registry

EXPECTED = range(1, 81)


def main() -> int:
    ignore_refs = "--ignore-missing-refs" in sys.argv
    modules, errors = load_registry(strict=False)
    if ignore_refs:
        errors = [e for e in errors if "does not exist" not in e]
    present = {m.no for m in modules}
    missing = [n for n in EXPECTED if n not in present]
    print(f"modules: {len(modules)}   entities: {len(all_entities())}   "
          f"fields: {sum(len(e.fields) for e in all_entities())}")
    if missing:
        print(f"missing module numbers: {missing}")
    if errors:
        print(f"\n{len(errors)} problem(s):")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("all module definitions are valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
