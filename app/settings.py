"""Configuration loading.

Real credentials live in ``config.json`` (gitignored). Copy
``config.example.json`` to ``config.json`` and fill it in.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Tuple

CONFIG_PATH = Path("config.json")


class ConfigError(RuntimeError):
    """Raised when the config file is missing or invalid."""


@dataclass
class Config:
    account: str
    password: str
    spc_f: str
    headless: bool = False
    base_url: str = "https://seller.shopee.tw"
    download_dir: str = "data"
    slow_mo_ms: int = 120
    viewport: Tuple[int, int] = (1366, 800)

    # extra fields present in the json are ignored, so we can extend without breaking
    _raw: dict = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> "Config":
        if not path.exists():
            raise ConfigError(
                f"config file not found: {path.resolve()}. "
                "Copy config.example.json to config.json and fill it in."
            )
        raw = json.loads(path.read_text(encoding="utf-8"))
        for key in ("account", "password", "spc_f"):
            if not raw.get(key):
                raise ConfigError(f"config.json is missing required field: {key}")
        vp = raw.get("viewport", [1366, 800])
        return cls(
            account=raw["account"],
            password=raw["password"],
            spc_f=raw["spc_f"],
            headless=bool(raw.get("headless", False)),
            base_url=raw.get("base_url", "https://seller.shopee.tw").rstrip("/"),
            download_dir=raw.get("download_dir", "data"),
            slow_mo_ms=int(raw.get("slow_mo_ms", 120)),
            viewport=(int(vp[0]), int(vp[1])),
            _raw=raw,
        )

    @property
    def download_path(self) -> Path:
        p = Path(self.download_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p
