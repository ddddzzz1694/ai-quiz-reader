# -*- coding: utf-8 -*-
"""回归验证 v3：正确触发完成页"""
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
        const tx = db.transaction(['sets','records'], 'readwrite');
        tx.objectStore('sets').put({
            id:'ts1', title:'测试题集', source:'x', createdAt: Date.now(), updatedAt: Date.now(),
            questions:[
                {question:'Q1?', options:['A1','B1','C1','D1'], answer:'A', explanation:'E1', difficulty:'简单'},
                {question:'Q2?', options:['A2','B2','C2','D2'], answer:'B', explanation:'E2', difficulty:'中等'},
                {question:'Q3?', options:['A3','B3','C3','D3'], answer:'C', explanation:'E3', difficulty:'困难'}
            ]
        });
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

    info = page.text_content("#last-set-info") or ""
    print("1. 首页统计(已答1错1):", "PASS" if "已答 1 · 错 1" in info else f"FAIL {info}")

    page.click("#btn-continue")
    time.sleep(1)
    for idx, ai in enumerate([0, 1, 2]):
        page.locator(".option-btn").nth(ai).click()
        time.sleep(0.3)
        page.click("#btn-submit")
        time.sleep(0.8)
        page.click("#btn-next")  # 每题都点下一题，第3题触发完成页
        time.sleep(0.8)
    done = page.text_content("#done-stats") or ""
    print("2. 完成页统计(对3错0):", "PASS" if "对 3 · 错 0" in done else f"FAIL {done}")

    page.click("#btn-back-home")
    time.sleep(1)
    info2 = page.text_content("#last-set-info") or ""
    print("3. 重刷后错题减少(错0):", "PASS" if "错 0" in info2 else f"FAIL {info2}")

    page.click('.tab[data-view="data"]')
    time.sleep(1)
    stats = page.text_content("#data-stats") or ""
    print("4. 数据页统计:", stats.replace(chr(10), " ").strip()[:90])

    page.locator('[data-act="detail"]').first.click()
    time.sleep(1)
    body = page.text_content(".detail-body") or ""
    print("5. 明细含选项文字(A1):", "PASS" if "A1" in body else f"FAIL {body[:80]}")
    print("JS 错误:", errors[:3] if errors else "无")
    browser.close()
