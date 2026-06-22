"""The download-tab flow:

  我的商品 → 更新商品資料 → 下載 tab → tick 備貨天數 → click 下載 →
  wait for export → download the generated zip → extract the xls.

Returns the extracted .xls/.xlsx path on success.
"""
from __future__ import annotations

import logging
import zipfile
from pathlib import Path

from playwright.sync_api import Page, TimeoutError as PWTimeout

from app.settings import Config
from app.shopee import selectors as S
from app.shopee.client import _shot

log = logging.getLogger(__name__)


def _click_text(page: Page, label: str, alt: str | None = None) -> bool:
    """Click the first element whose visible text matches label (or alt).
    Returns True if something was clicked."""
    for text in [label, alt] if alt else [label]:
        if not text:
            continue
        loc = page.locator(f"text={text}").first
        try:
            loc.wait_for(state="visible", timeout=4000)
            loc.click()
            log.info("clicked text: %s", text)
            return True
        except PWTimeout:
            continue
        except Exception as exc:
            log.warning("clicking %r failed: %s", text, exc)
    return False


def open_download_tab(page: Page) -> None:
    log.info("navigating to 我的商品")
    # Try a direct URL first; fall back to sidebar click.
    page.goto("https://seller.shopee.tw/portal/product/all", wait_until="domcontentloaded")
    _shot(page, "10_my_products")

    log.info("opening 更新商品資料")
    if not _click_text(page, S.LABEL_UPDATE_PRODUCT_INFO, S.LABEL_UPDATE_PRODUCT_INFO_ALT):
        raise RuntimeError("找不到「更新商品資料」入口 — check selectors.LABEL_UPDATE_PRODUCT_INFO")
    page.wait_for_load_state("networkidle")
    _shot(page, "11_update_product_info")

    log.info("switching to 下載 tab")
    if not _click_text(page, S.LABEL_DOWNLOAD_TAB):
        # try the role=button selector as a backup
        try:
            page.click(S.DOWNLOAD_TAB_BUTTON)
            log.info("clicked 下載 via selector fallback")
        except Exception:
            raise RuntimeError("找不到「下載」分頁 — check selectors.LABEL_DOWNLOAD_TAB")
    page.wait_for_load_state("networkidle")
    _shot(page, "12_download_tab")


def select_days_to_ship(page: Page) -> None:
    log.info("selecting 備貨天數 field for export")
    clicked = _click_text(page, S.LABEL_DAYS_TO_SHIP, S.LABEL_DAYS_TO_SHIP_ALT)
    if not clicked:
        raise RuntimeError(
            "找不到「備貨天數」欄位選項 — check selectors.LABEL_DAYS_TO_SHIP. "
            "It may be inside a dropdown that needs opening first."
        )
    _shot(page, "13_days_selected")


def trigger_and_capture(page: Page, cfg: Config) -> Path:
    """Click 下載 to generate, then download the produced zip. Returns zip path."""
    download_dir = cfg.download_path

    # Step 1: request generation
    log.info("clicking 下載 to generate export")
    try:
        page.click(S.DOWNLOAD_GENERATE_BUTTON)
    except PWTimeout:
        _shot(page, "14_generate_failed")
        raise RuntimeError("找不到「下載/產生檔案」按鈕 — check selectors.DOWNLOAD_GENERATE_BUTTON")
    _shot(page, "14_generate_clicked")

    # Step 2: wait for the file to appear in 下載紀錄 and click its link.
    # Use expect_download to catch the browser download triggered by that link.
    log.info("waiting for export to appear in 下載紀錄")
    with page.expect_download(timeout=180_000) as dl_info:
        # First row's download link; Shopee generates async so retry the click.
        link = page.locator(S.DOWNLOAD_HISTORY_ROW_LINK).first
        try:
            link.wait_for(state="attached", timeout=180_000)
        except PWTimeout:
            _shot(page, "15_no_history_row")
            raise RuntimeError(
                "匯出檔案未出現在下載紀錄中 (timeout 180s). "
                "The export may still be generating or selectors.DOWNLOAD_HISTORY_ROW_LINK needs fixing."
            )
        link.click()

    download = dl_info.value
    zip_path = download_dir / f"products_{download.suggested_filename or 'export.zip'}"
    download.save_as(str(zip_path))
    log.info("saved zip → %s", zip_path)
    return zip_path


def extract_xls(zip_path: Path, dest_dir: Path) -> Path:
    """Extract the spreadsheet from the zip. Returns the xls/xlsx path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        members = [n for n in zf.namelist() if n.lower().endswith((".xls", ".xlsx"))]
        if not members:
            raise RuntimeError(f"no .xls/.xlsx found inside {zip_path}; contents: {zf.namelist()}")
        zf.extractall(dest_dir)
        extracted = dest_dir / members[0]
    log.info("extracted spreadsheet → %s", extracted)
    return extracted


def run_download(page: Page, cfg: Config) -> Path:
    """Full download phase. Returns the extracted spreadsheet path."""
    open_download_tab(page)
    select_days_to_ship(page)
    zip_path = trigger_and_capture(page, cfg)
    return extract_xls(zip_path, cfg.download_path / "extracted")
