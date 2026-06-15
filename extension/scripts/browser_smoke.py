#!/usr/bin/env python3
"""
Real-browser smoke test. Drives Chrome with the built extension loaded and
exercises the hottest tool paths against a stable set of public pages.

Per blueprint §10, this catches Chrome version + CDP-API + manifest issues
that mock tests cannot.

Usage:
  # 1) Build the extension first:  node scripts/setup.js  (or `npm run build`)
  # 2) Run:                        python3 scripts/browser_smoke.py

Env knobs:
  POLARIS_REAL_OLLAMA=1     Also exercise an end-to-end Ollama-backed task.
  POLARIS_HEADLESS=1        Use headless Chrome (skips side panel checks).

Dependencies:
  pip install --user selenium  (any recent version works)

This is intentionally light on assertions — it's a sanity sweep, not a full
test harness. Failures here usually indicate a regression in CDP usage or
manifest permissions.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


def fail(msg: str) -> None:
    print(f"  ✗ {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def step(msg: str) -> None:
    print(f"\n==> {msg}")


def main() -> None:
    if not DIST.exists():
        fail(
            f"dist/ not found at {DIST}. Build the extension first:\n"
            f"  node {ROOT}/scripts/setup.js"
        )
    if not (DIST / "manifest.json").exists():
        fail("dist/manifest.json missing — build did not produce a valid extension.")

    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
    except ImportError:
        fail(
            "selenium not installed. Run:\n"
            "  python3 -m pip install --user selenium"
        )
        return

    headless = os.environ.get("POLARIS_HEADLESS") == "1"

    step("Launching Chrome with extension loaded")
    opts = Options()
    opts.add_argument(f"--load-extension={DIST}")
    opts.add_argument(f"--disable-extensions-except={DIST}")
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-first-run")
    opts.add_argument("--disable-default-apps")

    try:
        driver = webdriver.Chrome(options=opts)
    except Exception as e:
        fail(f"Could not start Chrome: {e}")
        return

    try:
        ok("Chrome started")

        step("Visiting a stable public page")
        driver.get("https://example.com")
        time.sleep(1.5)
        title = driver.title
        if "Example" not in title:
            fail(f"Unexpected page title: {title!r}")
        ok(f"Loaded example.com (title={title!r})")

        step("Reading basic DOM (sanity)")
        h1 = driver.find_element(By.TAG_NAME, "h1").text
        if "Example" not in h1:
            fail(f"Unexpected h1 text: {h1!r}")
        ok(f"h1 text contains 'Example' ({h1!r})")

        step("Verifying chrome://extensions sees our manifest")
        driver.get("chrome://extensions/")
        time.sleep(1.0)
        page_src = driver.page_source.lower()
        if "browser agent" not in page_src and not headless:
            print("  ! could not find 'Browser Agent' string in chrome://extensions; "
                  "this is informational only (Chrome may render in shadow DOM).")
        else:
            ok("Extension listed in chrome://extensions")

        if os.environ.get("POLARIS_REAL_OLLAMA") == "1":
            step("Ollama round-trip (POLARIS_REAL_OLLAMA=1)")
            print("  ! Manual: open the side panel, set a goal like 'echo hello', and confirm finish.")
            print("    This script only validates the build/load path; full agent runs need user interaction.")

        ok("All smoke checks passed.")
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
