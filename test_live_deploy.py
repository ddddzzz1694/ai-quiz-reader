# -*- coding: utf-8 -*-
"""线上部署验证：https 环境 SW 离线能力 + 核心功能"""
from playwright.sync_api import sync_playwright
import time

URL = "https://ddddzzz1694.github.io/ai-quiz-reader/"
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="networkidle", timeout=60000)
    time.sleep(3)

    print("1. 页面加载:", "PASS" if "AI出题读书法" in page.title() else "FAIL")

    # SW 注册（https 环境应成功）
    sw = page.evaluate("""() => new Promise((res) => {
        if (!('serviceWorker' in navigator)) return res('no-support');
        navigator.serviceWorker.ready.then(() => res('ready')).catch(e => res('err:' + e.message));
    })""")
    print("2. Service Worker(https):", "PASS" if sw == "ready" else f"FAIL {sw}")

    # 规则页（纯本地）
    page.click('.tab[data-view="prompt"]')
    time.sleep(1)
    plen = len(page.input_value("#prompt-text"))
    print("3. 规则页(本地):", "PASS" if plen > 100 else f"FAIL len={plen}")

    # 设置页
    page.click('.tab[data-view="settings"]')
    time.sleep(1)
    print("4. 设置页:", "PASS" if page.is_visible("#set-apikey") else "FAIL")

    # 数据页
    page.click('.tab[data-view="data"]')
    time.sleep(1)
    print("5. 数据页:", "PASS" if page.is_visible("#data-stats") else "FAIL")

    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
