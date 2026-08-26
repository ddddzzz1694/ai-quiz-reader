# -*- coding: utf-8 -*-
"""调试：回滚按钮点击后到底发生了什么"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: print("  [console]", m.text[:100]) if m.type == "error" else None)

    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate('() => caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))')
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)

    page.click('.tab[data-view="prompt"]')
    time.sleep(2)

    # 列出所有回滚按钮及其 data-file
    btns = page.evaluate("""() => [...document.querySelectorAll('[data-restore="1"]')].map(b => b.dataset.file)""")
    print("回滚按钮对应文件:", btns)

    # 点击第一个（最新存档）
    target = btns[0]
    print(f"点击回滚到: {target}")
    dialog_seen = []
    page.on("dialog", lambda d: (dialog_seen.append(d.message), d.accept()))
    page.locator('[data-restore="1"]').first.click()
    time.sleep(3)

    print("dialog 触发:", "PASS" if dialog_seen else "FAIL（没弹确认框）", dialog_seen[:1])
    restored = page.input_value("#prompt-text")
    print("回滚后 prompt-text 尾部:", repr(restored.strip()[-20:]))
    print("回滚后长度:", len(restored))
    status = page.text_content("#prompt-status") or ""
    print("状态区:", status.strip()[:80])
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
