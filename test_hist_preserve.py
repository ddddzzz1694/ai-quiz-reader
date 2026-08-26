# -*- coding: utf-8 -*-
"""作答历史全留存测试：重刷后历次记录都保留"""
from playwright.sync_api import sync_playwright
import time

INJECT = """
() => new Promise((resolve) => {
    const req = indexedDB.open('quiz_app', 1);
    req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', {keyPath:'id'});
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath:'id'});
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'key'});
    };
    req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['sets'], 'readwrite');
        tx.objectStore('sets').put({
            id:'ts1', title:'历史测试', source:'x', createdAt: Date.now(), updatedAt: Date.now(),
            questions:[{question:'Q1?', options:['A1','B1','C1','D1'], answer:'A', explanation:'E1', difficulty:'简单'}]
        });
        resolve(true);
    };
})
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate(INJECT)
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)

    def answer_once(write_supplement):
        page.click("#btn-continue")
        time.sleep(1)
        page.locator(".option-btn").nth(0).click()
        time.sleep(0.3)
        if write_supplement:
            page.fill("#supplement-text", "第一次的感想")
        page.click("#btn-submit")
        time.sleep(1.5)  # 等 AI 点评尝试（无Key会降级）
        page.click("#btn-next")
        time.sleep(0.8)

    # 第一次刷：写感想
    answer_once(True)
    # 回首页再刷第二次：不写感想
    page.click("#btn-back-home")
    time.sleep(1)
    answer_once(False)
    page.click("#btn-back-home")
    time.sleep(1)

    # 查明细：应看到"共刷 2 次"，且第一次的感想还在
    page.click('.tab[data-view="data"]')
    time.sleep(1)
    page.locator('[data-act="detail"]').first.click()
    time.sleep(1.2)
    body = page.text_content(".detail-body") or ""
    print("1. 显示共刷2次:", "PASS" if "共刷 2 次" in body else f"FAIL {body[:80]}")
    print("2. 第一次感想保留:", "PASS" if "第一次的感想" in body else "FAIL(感想丢失)")
    print("3. 两次作答都在:", "PASS" if body.count("我的选择") >= 2 else f"FAIL count={body.count('我的选择')}")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
