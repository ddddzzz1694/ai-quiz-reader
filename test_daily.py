# -*- coding: utf-8 -*-
"""B3 每日目标测试：设目标→答题→进度更新→达标提示"""
from playwright.sync_api import sync_playwright
import time

INJECT = """
() => new Promise((resolve) => {
    const req = indexedDB.open('quiz_app', 2);
    req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'key'});
        if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', {keyPath:'id'});
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath:'id'});
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', {keyPath:'id'});
        if (!db.objectStoreNames.contains('transfers')) db.createObjectStore('transfers', {keyPath:'id'});
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', {keyPath:'id'});
    };
    req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['sets','settings'], 'readwrite');
        tx.objectStore('sets').put({
            id:'ts1', title:'目标测试', source:'x'.repeat(100), createdAt: Date.now(), updatedAt: Date.now(),
            questions:[{question:'Q1?', options:['A','B','C','D'], answer:'A', explanation:'E1', difficulty:'简单'}]
        });
        tx.objectStore('settings').put({key:'dailyGoal', value:2});
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
    # 1. 今日进度显示
    print("1. 进度条显示:", "PASS" if page.is_visible("#daily-progress") else "FAIL")
    t1 = page.text_content("#daily-text") or ""
    print("2. 初始 0/2:", "PASS" if "0/2" in t1 else f"FAIL {t1}")
    # 3. 答一题
    page.click("#btn-continue")
    time.sleep(1)
    page.locator(".option-btn").nth(0).click()
    time.sleep(0.3)
    page.click("#btn-submit")
    time.sleep(1)
    page.click("#btn-next")
    time.sleep(0.8)
    page.click("#btn-back-home")
    time.sleep(1)
    t2 = page.text_content("#daily-text") or ""
    print("3. 答1题后 1/2:", "PASS" if "1/2" in t2 else f"FAIL {t2}")
    # 4. 设置页 goal-value
    page.click('.tab[data-view="settings"]')
    time.sleep(1)
    gv = page.text_content("#goal-value") or ""
    print("4. 设置页目标值(2):", "PASS" if gv == "2" else f"FAIL {gv}")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
