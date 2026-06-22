"""Local dashboard: trigger runs and watch logs.

Run with:  python run.py   →   http://127.0.0.1:8000
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from app import logger
from app.jobs import pipeline
from app.settings import Config, ConfigError

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(title="Shopee 備貨天數 工具")
_executor = ThreadPoolExecutor(max_workers=1)  # serialize runs

_cfg: Config | None = None


def _config() -> Config:
    global _cfg
    if _cfg is None:
        _cfg = Config.load()
    return _cfg


@app.on_event("startup")
def _startup() -> None:
    logger.setup_logging()
    try:
        _config()
        log.info("config loaded OK")
    except ConfigError as exc:
        log.error("config error: %s", exc)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return TEMPLATES.TemplateResponse("index.html", {"request": request})


@app.get("/api/status")
def status():
    cfg_ok = True
    try:
        _config()
    except ConfigError as exc:
        cfg_ok = False
        log.warning("config not ready: %s", exc)

    last = pipeline.last_result()
    return {
        "running": pipeline.is_running(),
        "config_ok": cfg_ok,
        "last": {
            "ok": last.ok,
            "phase": last.phase,
            "error": last.error,
            "spreadsheet_path": last.spreadsheet_path,
            "stages": last.stages,
        } if last else None,
    }


@app.get("/api/logs")
def logs(since: float = 0.0):
    return {"logs": logger.recent_logs(float(since))}


@app.get("/api/downloads")
def downloads():
    base = Path("data/extracted")
    files = []
    if base.exists():
        for p in sorted(base.glob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
            files.append({"name": p.name, "size": p.stat().st_size})
    return {"files": files}


@app.post("/api/run")
def run():
    if pipeline.is_running():
        return JSONResponse({"started": False, "reason": "already running"}, status_code=409)
    try:
        cfg = _config()
    except ConfigError as exc:
        return JSONResponse({"started": False, "reason": str(exc)}, status_code=400)

    _executor.submit(pipeline.run, cfg)
    return {"started": True}
