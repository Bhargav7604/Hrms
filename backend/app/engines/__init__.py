"""Business engines. Each module here is imported at startup (see app.main.load_engines):
it registers entity hooks / event listeners on import and may expose `router` and/or
`public_router` (FastAPI APIRouter) which are mounted automatically.

Shared helpers live in `_common.py`.
"""
