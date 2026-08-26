# -*- coding: utf-8 -*-
"""最终确认：回滚到最早存档版本（19-06_v1 干净原版）"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate('() => caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))')
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)
    page.click('.tab[data-view="prompt"]')
    time.sleep(2)

    files = page.evaluate('() => Array.from(document.querySelectorAll("[data-restore=\\"1\\"]")).map(b => b.dataset.file)')
    print("存档版本:", files)
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.locator('[data-restore="1"]').nth(len(files) - 1).click()
    time.sleep(3)
    print("confirm:", "PASS 触发" if dialogs else "FAIL 未触发")
    restored = page.input_value("#prompt-text")
    print("回滚到最早版本后:", "PASS（不含追加行）" if "（测试追加行）" not in restored else "FAIL（仍含）")
    print("长度:", len(restored), "字符 | 尾部:", repr(restored.strip()[-20:]))
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
