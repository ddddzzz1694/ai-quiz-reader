# -*- coding: utf-8 -*-
"""深度诊断：点击回滚按钮后的完整行为"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    requests = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: requests.append(r.url) if "/api/" in r.url else None)

    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate('() => caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))')
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)
    page.click('.tab[data-view="prompt"]')
    time.sleep(2)

    # 检查 div.onclick 是否存在且是 async
    probe = page.evaluate("""() => {
        const divs = [...document.querySelectorAll('.hist-item')];
        return divs.map((d, i) => ({
            idx: i,
            hasOnclick: typeof d.onclick === 'function',
            onclickSrc: d.onclick ? String(d.onclick).slice(0, 80) : 'none',
            btns: [...d.querySelectorAll('button')].map(b => b.dataset.file + (b.dataset.restore ? '[回滚]' : '[查看]'))
        }));
    }""")
    print("历史项诊断:")
    for row in probe:
        print(" ", row)

    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    requests.clear()
    page.locator('[data-restore="1"]').nth(2).click()
    time.sleep(3)
    print()
    print("点击后 /api/ 请求:", requests)
    print("dialog:", "触发" if dialogs else "未触发", dialogs[:1])
    status = page.text_content("#prompt-status") or ""
    print("状态区:", repr(status.strip()[:100]))
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
