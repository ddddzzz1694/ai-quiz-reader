# -*- coding: utf-8 -*-
"""B4 统计看板测试"""
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
        const tx = db.transaction(['sets','records','books'], 'readwrite');
        tx.objectStore('books').put({id:'bk1', title:'非暴力沟通', createdAt: Date.now()});
        tx.objectStore('sets').put({
            id:'ts1', title:'NVC', source:'x', bookId:'bk1', createdAt: Date.now(), updatedAt: Date.now(),
            questions:[{question:'Q1?', options:['A','B','C','D'], answer:'A', explanation:'E', difficulty:'简单'}]
        });
        const now = Date.now();
        tx.objectStore('records').put({id:'r1', setId:'ts1', qIndex:0, answer:'A', correct:true, supplement:'', ts: now});
        tx.objectStore('records').put({id:'r2', setId:'ts1', qIndex:0, answer:'B', correct:false, supplement:'', ts: now - 3600000});
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
    page.click('.tab[data-view="data"]')
    time.sleep(1)
    print("1. 统计按钮:", "PASS" if page.is_visible("#btn-stats-view") else "FAIL")
    page.click("#btn-stats-view")
    time.sleep(1.5)
    stats = page.text_content(".stats-box") or ""
    print("2. 统计标题:", "PASS" if "统计" in (page.text_content("#data-title") or "") else "FAIL")
    print("3. 含近7天折线:", "PASS" if "近 7 天" in stats and "<svg" in page.inner_html(".stats-svg") else "FAIL")
    print("4. 含每本书掌握度:", "PASS" if "非暴力沟通" in stats and "%" in stats else "FAIL")
    print("5. 返回按钮:", "PASS" if page.is_visible("#stats-back") else "FAIL")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
