# -*- coding: utf-8 -*-
"""B1 多本书管理测试：建书→出题归书→按书筛选→刷新保留"""
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
        const tx = db.transaction(['books','sets'], 'readwrite');
        tx.objectStore('books').put({id:'bk1', title:'非暴力沟通', createdAt: Date.now()});
        tx.objectStore('sets').put({
            id:'ts1', title:'NVC第一章', source:'x'.repeat(100), bookId:'bk1',
            createdAt: Date.now(), updatedAt: Date.now(),
            questions:[{question:'Q1?', options:['A','B','C','D'], answer:'A', explanation:'E', difficulty:'简单'}]
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
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message[:40]), d.accept()))
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate(INJECT)
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)

    # 1. 我的书面板显示
    print("1. 我的书面板:", "PASS" if page.is_visible("#books-panel") else "FAIL")
    print("2. 书列表含非暴力沟通:", "PASS" if "非暴力沟通" in (page.text_content("#book-list") or "") else "FAIL")
    print("3. 选择框含书:", "PASS" if page.locator("#book-select option").count() >= 2 else "FAIL")
    # 4. 点书 → 数据页按书筛选
    page.locator('.book-item[data-book="bk1"]').click()
    time.sleep(1.2)
    title = page.text_content("#data-title") or ""
    sets_shown = page.locator("#set-list .set-item").count()
    print("4. 点书进数据页:", "PASS" if "非暴力沟通" in title and sets_shown == 1 else f"FAIL title={title} sets={sets_shown}")
    # 5. 返回全部
    page.click("#btn-data-all")
    time.sleep(1)
    sets_all = page.locator("#set-list .set-item").count()
    print("5. 返回全部:", "PASS" if sets_all == 1 else f"FAIL sets={sets_all}")
    # 6. 刷新保留
    page.reload(wait_until="networkidle")
    time.sleep(1.5)
    print("6. 刷新后书还在:", "PASS" if "非暴力沟通" in (page.text_content("#book-list") or "") else "FAIL")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
