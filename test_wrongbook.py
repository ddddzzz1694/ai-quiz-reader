# -*- coding: utf-8 -*-
"""B2 错题本测试：答错题进错题本→重练答对→错题本减少"""
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
        const tx = db.transaction(['sets','records'], 'readwrite');
        tx.objectStore('sets').put({
            id:'ts1', title:'错题测试', source:'x'.repeat(100), createdAt: Date.now(), updatedAt: Date.now(),
            questions:[
                {question:'Q1?', options:['A','B','C','D'], answer:'A', explanation:'E1', difficulty:'简单'},
                {question:'Q2?', options:['A','B','C','D'], answer:'B', explanation:'E2', difficulty:'中等'}
            ]
        });
        // Q1 答错（最新一条是错的）
        tx.objectStore('records').put({id:'r1', setId:'ts1', qIndex:0, answer:'B', correct:false, supplement:'', ts: Date.now()-60000});
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
    print("1. 错题本按钮:", "PASS" if page.is_visible("#btn-wrong-book") else "FAIL")
    page.click("#btn-wrong-book")
    time.sleep(1.2)
    wrong_body = page.text_content("#wrong-list") or ""
    print("2. 错题本显示Q1(错题):", "PASS" if "Q1?" in wrong_body and "Q2?" not in wrong_body else f"FAIL {wrong_body[:80]}")
    # 重练 Q1 答对
    page.locator('[data-wrong-practice]').first.click()
    time.sleep(1)
    page.locator(".option-btn").nth(0).click()  # 答对 A
    time.sleep(0.3)
    page.click("#btn-submit")
    time.sleep(1)
    page.click("#btn-next")
    time.sleep(1)
    page.click("#btn-back-home")
    time.sleep(1)
    page.click('.tab[data-view="data"]')
    time.sleep(1)
    page.click("#btn-wrong-book")
    time.sleep(1.2)
    wrong2 = page.text_content("#wrong-list") or ""
    print("3. 重练答对后错题本空:", "PASS" if "没有错题" in wrong2 else f"FAIL {wrong2[:80]}")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
