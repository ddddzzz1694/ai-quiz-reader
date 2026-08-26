# -*- coding: utf-8 -*-
"""新功能测试：先注入题集数据，再测答题明细 + 设置难度/题型 + AI点评降级"""
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
                {question:'Q2?', options:['A2','B2','C2','D2'], answer:'B', explanation:'E2', difficulty:'中等'}
            ]
        });
        tx.objectStore('records').put({id:'r1', setId:'ts1', qIndex:0, answer:'B', correct:false, supplement:'我的感想', ts: Date.now()});
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

    # 1. 设置页新选项
    page.click('.tab[data-view="settings"]')
    time.sleep(1)
    diff_btns = page.locator("#seg-difficulty .seg-btn").count()
    types_btns = page.locator("#seg-types .seg-btn").count()
    print("1. 难度选项(4):", "PASS" if diff_btns == 4 else f"FAIL count={diff_btns}")
    print("2. 题型选项(2):", "PASS" if types_btns == 2 else f"FAIL count={types_btns}")
    page.click('[data-difficulty="easy"]')
    time.sleep(0.8)
    saved = page.evaluate("""async () => {
        const req = indexedDB.open('quiz_app', 1);
        return new Promise((res) => { req.onsuccess = () => {
            const db = req.result;
            const g = db.transaction('settings').objectStore('settings').get('difficulty');
            g.onsuccess = () => res(g.result ? g.result.value : null);
        }; });
    }""")
    print("3. 难度保存:", "PASS" if saved == "easy" else f"FAIL saved={saved}")

    # 2. 数据页：答题明细
    page.click('.tab[data-view="data"]')
    time.sleep(1)
    detail_btn = page.locator('[data-act="detail"]').count()
    print("4. 答题明细按钮:", "PASS" if detail_btn >= 1 else f"FAIL count={detail_btn}")
    if detail_btn:
        page.locator('[data-act="detail"]').first.click()
        time.sleep(1)
        print("5. 明细弹层打开:", "PASS" if page.is_visible(".detail-panel") else "FAIL")
        body = page.text_content(".detail-body") or ""
        print("   明细含感想:", "PASS" if "我的感想" in body else "FAIL")
        page.click("#detail-close")
        time.sleep(0.5)

    # 3. 刷题页：提交+感想，无Key时AI点评静默降级
    page.locator('[data-act="practice"]').first.click()
    time.sleep(1)
    page.locator(".option-btn").first.click()
    time.sleep(0.5)
    page.fill("#supplement-text", "我的感想测试")
    page.click("#btn-submit")
    time.sleep(2.5)
    print("6. 提交+感想后无JS错误(无Key降级):", "PASS" if not errors else f"FAIL {errors[:2]}")

    print("总错误:", errors[:3] if errors else "无")
    browser.close()
