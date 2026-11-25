from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    bootstrap_key: str
    secret_key: str
    public_url: str
    allow_http_loopback: bool = False
    scheduler_enabled: bool = True
    scheduler_interval: float = 1.0
    cors_origins: tuple[str, ...] = ("*",)
