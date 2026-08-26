# -*- coding: utf-8 -*-
"""干净的回滚测试：无任何 probe 污染，验证 div.onclick 委托是否工作"""
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

    # 干净点击第一个回滚按钮
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.locator('[data-restore="1"]').nth(0).click()
    time.sleep(3)

    print("confirm 对话框触发:", "PASS" if dialogs else "FAIL（div.onclick 没执行或没弹确认）")
    if dialogs:
        print("  对话框内容:", dialogs[0][:60])
    restored = page.input_value("#prompt-text")
    print("回滚后尾部:", repr(restored.strip()[-20:]))
    status = page.text_content("#prompt-status") or ""
    print("状态区:", status.strip()[:80])
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
