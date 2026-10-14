from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_ROOT / ".env", extra="ignore")

    env: str = "development"
    database_url: str = "postgresql+asyncpg://vlack:vlack@127.0.0.1:5432/vlack_hrms"
    redis_url: str = "redis://127.0.0.1:6379/0"
    jwt_secret: str = "dev-only-secret-change-me-before-going-live"
    token_ttl_hours: int = 12
    hospital_name: str = "Vlack Multispecialty Hospital"
    branch_id: str = "MAIN"
    timezone: str = "Asia/Kolkata"
    upload_dir: Path = BACKEND_ROOT / "data" / "uploads"
    max_upload_mb: int = 20
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    web_dist: Path = BACKEND_ROOT.parent / "web" / "dist"
    # Optional LLM for the AI Engine. Without a key the engine drafts deterministically.
    anthropic_api_key: str = ""
    ai_model: str = "claude-opus-5-5"
    # Billing: discounts above this % of the bill route through the approval workflow.
    discount_approval_percent: float = 10
    # Notifications: "log" stores messages in the outbox only; real gateways plug into engines/notify.py.
    notify_mode: str = "log"
    # Run Alembic migrations on startup (handy in dev / single-node installs).
    auto_migrate: bool = True
    login_max_attempts: int = 10
    # Devices & Sessions: sign-ins allowed at once per user; the oldest is signed out beyond it
    # (0 = unlimited). Overridable at runtime by the org-level setting security.max_concurrent_sessions.
    max_concurrent_sessions: int = 2
    # Patient portal: also show other patients registered on the same OTP-verified mobile
    # (shared household phone). Off by default (DPDP: access only via explicit family/delegate links).
    portal_shared_mobile_access: bool = False
    # Refuse to start when a module definition is invalid (set false only while authoring modules).
    strict_modules: bool = True
    sql_echo: bool = False

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def sync_database_url(self) -> str:
        return self.database_url.replace("+asyncpg", "+psycopg")


settings = Settings()

if settings.env == "production" and settings.jwt_secret.startswith("dev-only"):
    raise RuntimeError("JWT_SECRET must be set in production")
