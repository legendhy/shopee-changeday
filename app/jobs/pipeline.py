"""End-to-end pipeline orchestration.

Phases:
  1. DOWNLOAD  — implemented now (the MVP).
  2. EDIT      — set 備貨天數=1 for all products. (scaffolded, phase 2)
  3. REZIP     — repackage edited xls into upload zip. (scaffolded, phase 2)
  4. UPLOAD    — upload zip back via seller center. (TODO, phase 2)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

from app.settings import Config
from app.shopee.client import open_session, login
from app.shopee.download import run_download
from app.spreadsheet import days_to_ship, zipio

log = logging.getLogger(__name__)


@dataclass
class RunResult:
    ok: bool
    phase: str
    spreadsheet_path: str | None = None
    error: str | None = None
    stages: list[str] = field(default_factory=list)


# ---- run state (single concurrent run) -------------------------------------
_state_lock = Lock()
_state = {"running": False, "last": None}


def is_running() -> bool:
    with _state_lock:
        return _state["running"]


def last_result() -> RunResult | None:
    with _state_lock:
        return _state["last"]


def run(cfg: Config) -> RunResult:
    """Execute the pipeline. Currently runs only the DOWNLOAD phase."""
    with _state_lock:
        if _state["running"]:
            raise RuntimeError("a run is already in progress")
        _state["running"] = True

    result = RunResult(ok=False, phase="download")
    try:
        result.stages.append("launch browser")
        with open_session(cfg) as session:
            result.stages.append("login")
            login(session.page, cfg)

            result.stages.append("download")
            xlsx = run_download(session.page, cfg)
            result.spreadsheet_path = str(xlsx)

            # ---- phase 2 (scaffolded) -------------------------------------
            # result.stages.append("edit days-to-ship")
            # days_to_ship.set_all_to_one(xlsx)
            #
            # result.stages.append("rezip")
            # upload_zip = zipio.rezip(xlsx, cfg.download_path / "upload.zip")
            #
            # result.stages.append("upload")
            # upload.run_upload(session.page, cfg, upload_zip)

        result.ok = True
        log.info("pipeline complete (download phase). spreadsheet=%s", result.spreadsheet_path)
    except Exception as exc:
        result.error = str(exc)
        log.exception("pipeline failed at %s", result.phase)
    finally:
        with _state_lock:
            _state["running"] = False
            _state["last"] = result
    return result
