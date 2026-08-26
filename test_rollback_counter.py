# -*- coding: utf-8 -*-
"""终极诊断：真实点击时 div.onclick 是否被调用"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    console_msgs = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console_msgs.append(f"{m.type}: {m.text[:150]}"))

    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate('() => caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))')
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)
    page.click('.tab[data-view="prompt"]')
    time.sleep(2)

    # 给 div.onclick 包一层计数
    page.evaluate("""() => {
        window.__divCalls = 0;
        document.querySelectorAll('.hist-item').forEach(div => {
            const orig = div.onclick;
            if (orig) {
                div.onclick = (e) => { window.__divCalls++; return orig(e); };
            }
        });
    }""")

    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.locator('[data-restore="1"]').nth(0).click()
    time.sleep(3)

    calls = page.evaluate("() => window.__divCalls")
    print("div.onclick 被调用次数:", calls)
    print("dialog:", "触发" if dialogs else "未触发", dialogs[:1])
    print("console 消息:")
    for m in console_msgs[-8:]:
        print("  ", m)
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
