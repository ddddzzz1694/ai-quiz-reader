# -*- coding: utf-8 -*-
"""纯前端规则管理测试：保存→历史→回滚（不依赖服务器 API）"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message[:60]), d.accept()))

    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    # 清掉之前测试污染的 prompt 设置
    page.evaluate("""async () => {
        const req = indexedDB.open('quiz_app', 1);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('settings', 'readwrite');
            tx.objectStore('settings').delete('prompt');
            tx.objectStore('settings').delete('prompt_history');
        };
    }""")
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)

    # 1. 打开规则页，确认显示内置默认
    page.click('.tab[data-view="prompt"]')
    time.sleep(1)
    initial = page.input_value("#prompt-text")
    print("1. 初始规则加载:", "PASS" if len(initial) > 100 else f"FAIL len={len(initial)}")

    # 2. 修改并保存
    modified = initial + "\n\n（测试：新增一条规则）"
    page.fill("#prompt-text", modified)
    page.click("#btn-save-prompt")
    time.sleep(1.5)
    status = page.text_content("#prompt-status") or ""
    print("2. 保存规则:", "PASS" if "已保存" in status else f"FAIL {status[:60]}")

    # 3. 历史版本出现
    hist_items = page.locator(".hist-item").count()
    print("3. 历史版本出现:", "PASS" if hist_items >= 1 else f"FAIL count={hist_items}")

    # 4. 回滚
    page.evaluate("""() => {
        const btn = document.querySelector('[data-restore="1"]');
        if (btn) btn.click();
    }""")
    time.sleep(2)
    after = page.input_value("#prompt-text")
    print("4. 回滚生效:", "PASS" if len(after) == len(initial) else f"FAIL len={len(after)} vs {len(initial)}")
    print("   回滚后是否无测试标记:", "PASS" if "测试：新增一条规则" not in after else "FAIL")

    # 5. 刷新后仍在（持久化）
    page.reload(wait_until="networkidle")
    time.sleep(1.5)
    page.click('.tab[data-view="prompt"]')
    time.sleep(1)
    persisted = page.input_value("#prompt-text")
    print("5. 刷新后规则保留:", "PASS" if len(persisted) == len(initial) else f"FAIL len={len(persisted)}")

    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
