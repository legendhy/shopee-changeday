"""Browser driver: launch Playwright, inject the SPC_F cookie, and reach the
authenticated seller center. If the cookie alone isn't enough, fall back to a
normal account/password login.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page, TimeoutError as PWTimeout

from app.settings import Config
from app.shopee import selectors as S

log = logging.getLogger(__name__)

SCREENSHOTS_DIR = Path("screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)


def _shot(page: Page, name: str) -> None:
    try:
        page.screenshot(path=str(SCREENSHOTS_DIR / f"{name}.png"), full_page=True)
        log.info("screenshot: %s", name)
    except Exception as exc:  # screenshots are best-effort
        log.warning("screenshot %s failed: %s", name, exc)


def _is_logged_in(page: Page, cfg: Config) -> bool:
    """Heuristic: if loading the seller portal does NOT bounce us to a login
    page, we're authenticated."""
    try:
        page.goto(cfg.base_url + "/seller", wait_until="domcontentloaded")
    except PWTimeout:
        pass
    url = page.url
    return "/login" not in url and "account/login" not in url


def login(page: Page, cfg: Config) -> None:
    """Reach the authenticated seller center. Tries cookie first, then form login."""
    log.info("injecting SPC_F cookie for .shopee.tw")
    # need to be on the domain first to set cookies
    page.goto("https://shopee.tw", wait_until="domcontentloaded")
    context = page.context
    context.add_cookies([{
        "name": "SPC_F",
        "value": cfg.spc_f,
        "domain": ".shopee.tw",
        "path": "/",
        "httpOnly": False,
        "secure": True,
        "sameSite": "None",
    }])

    if _is_logged_in(page, cfg):
        log.info("cookie login OK — already authenticated")
        return

    log.info("cookie not sufficient, performing form login")
    _form_login(page, cfg)


def _form_login(page: Page, cfg: Config) -> None:
    page.goto(cfg.base_url + "/account/login", wait_until="domcontentloaded")
    _shot(page, "01_login_page")

    page.fill(S.LOGIN_ACCOUNT_INPUT, cfg.account)
    page.fill(S.LOGIN_PASSWORD_INPUT, cfg.password)
    _shot(page, "02_login_filled")
    page.click(S.LOGIN_SUBMIT_BUTTON)

    # post-login: wait for nav away from login URL (may hit captcha / SMS — those
    # are manual and logged as a failure for the operator to complete).
    try:
        page.wait_for_url(lambda u: "/login" not in u and "account/login" not in u, timeout=20000)
    except PWTimeout:
        _shot(page, "03_login_blocked")
        raise RuntimeError(
            "Login did not complete within 20s — a captcha / 2FA / verification step "
            "may be required. Open the headed browser and finish it manually, then re-run."
        )
    log.info("form login OK")
    _shot(page, "03_after_login")


@dataclass
class BrowserSession:
    browser: Browser
    context: BrowserContext
    page: Page


@contextmanager
def open_session(cfg: Config) -> Iterator[BrowserSession]:
    """Yield a ready browser session; closes everything on exit."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=cfg.headless, slow_mo=cfg.slow_mo_ms)
        context = browser.new_context(
            viewport={"width": cfg.viewport[0], "height": cfg.viewport[1]},
            accept_downloads=True,
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0.0.0 Safari/537.36"),
        )
        page = context.new_page()
        try:
            yield BrowserSession(browser, context, page)
        finally:
            context.close()
            browser.close()
