"""Entrypoint: start the local dashboard.

    python run.py            → http://127.0.0.1:8000
"""
import uvicorn
from app import logger

if __name__ == "__main__":
    logger.setup_logging()
    uvicorn.run("app.web.server:app", host="127.0.0.1", port=8000, reload=False)
