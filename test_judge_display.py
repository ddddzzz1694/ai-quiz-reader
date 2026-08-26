# -*- coding: utf-8 -*-
"""判断题显示测试：选项显示'对/错'不显示A/B"""
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
        const tx = db.transaction(['sets'], 'readwrite');
        tx.objectStore('sets').put({
            id:'ts1', title:'判断题测试', source:'x', createdAt: Date.now(), updatedAt: Date.now(),
            questions:[
                {question:'非暴力沟通四步是观察-感受-需要-请求？', options:['对','错'], answer:'A', explanation:'对，正是这四步', difficulty:'简单'},
                {question:'以下哪句是观察？', options:['你总是迟到','你迟到了15分钟'], answer:'B', explanation:'观察是事实不带评判', difficulty:'中等'}
            ]
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
    page.click('#btn-continue')
    time.sleep(1)
    # 判断题：选项应显示"对""错"，无 A/B 字母
    opt1 = page.locator(".option-btn").nth(0).inner_text()
    opt2 = page.locator(".option-btn").nth(1).inner_text()
    print("1. 判断题选项:", f"[{opt1}] [{opt2}]", "PASS" if opt1.strip() == "对" and opt2.strip() == "错" else "FAIL")
    # 下一题（选择题）：显示字母
    page.click("#btn-submit")
    time.sleep(1)
    page.click("#btn-next")
    time.sleep(1)
    opt3 = page.locator(".option-btn").nth(0).inner_text()
    print("2. 选择题仍显示字母:", "PASS" if "A" in opt3 else f"FAIL [{opt3}]")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
