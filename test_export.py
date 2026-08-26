# -*- coding: utf-8 -*-
"""B5 导出增强测试：Markdown/纯文本内容"""
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
            id:'ts1', title:'导出测试', source:'x', createdAt: Date.now(), updatedAt: Date.now(),
            questions:[{question:'Q1?', options:['A','B','C','D'], answer:'A', explanation:'E1', difficulty:'简单'}]
        });
        tx.objectStore('records').put({id:'r1', setId:'ts1', qIndex:0, answer:'A', correct:true, supplement:'感想A', ts: Date.now(), aiComment:'点评A'});
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
    downloads = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.on("download", lambda d: downloads.append(d))
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)
    page.evaluate(INJECT)
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1.5)
    page.click('.tab[data-view="settings"]')
    time.sleep(1)
    # 导出 Markdown（选 2）
    page.click("#btn-export")
    time.sleep(0.8)
    page.keyboard.type("2")
    page.keyboard.press("Enter")
    time.sleep(2)
    print("1. Markdown 下载触发:", "PASS" if downloads and downloads[-1].suggested_filename.endswith(".md") else f"FAIL {[d.suggested_filename for d in downloads]}")
    # 导出纯文本（选 3）
    page.click("#btn-export")
    time.sleep(0.8)
    page.keyboard.type("3")
    page.keyboard.press("Enter")
    time.sleep(2)
    print("2. 纯文本下载触发:", "PASS" if downloads and downloads[-1].suggested_filename.endswith(".txt") else f"FAIL {[d.suggested_filename for d in downloads]}")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
