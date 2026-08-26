# -*- coding: utf-8 -*-
"""PWA 离线能力测试：加载 → SW 缓存 → 离线刷新 → 页面仍可用"""
from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # 1. 在线加载（触发 SW 注册 + 缓存）
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(2)
    sw_ok = page.evaluate("""() => new Promise((res) => {
        if (!('serviceWorker' in navigator)) return res('no-sw-support');
        navigator.serviceWorker.ready.then(() => res('ready')).catch(e => res('err:' + e.message));
    })""")
    print("1. Service Worker 注册:", "PASS" if sw_ok == "ready" else "FAIL " + str(sw_ok))

    # 2. 确认缓存已建立
    time.sleep(1)
    cache_ok = page.evaluate("""() => caches.keys().then(keys => keys.join(','))""")
    print("2. 缓存已建立:", "PASS" if "quiz-app" in str(cache_ok) else "FAIL " + str(cache_ok))

    # 3. 模拟离线（断网）
    ctx.set_offline(True)
    print("3. 已切换到离线模式")

    # 4. 离线刷新页面
    page.reload(wait_until="domcontentloaded")
    time.sleep(2)
    title_ok = "AI出题读书法" in page.title()
    home_ok = page.is_visible("#view-home")
    print("4. 离线刷新仍打开:", "PASS" if title_ok and home_ok else "FAIL")

    # 5. 离线状态下刷题界面可用（数据在 IndexedDB 本地）
    page.evaluate("""() => new Promise((resolve, reject) => {
        const req = indexedDB.open('quiz_app', 2);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', {keyPath:'id'});
            if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath:'id'});
            if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'id'});
        };
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('sets', 'readwrite');
            tx.objectStore('sets').put({
                id: 'offline-set', title: '离线测试题', source: 'x',
                createdAt: Date.now(), updatedAt: Date.now(),
                questions: [{question: '离线时能刷这道题吗？', options: ['能', '不能', '不知道', '试试'], answer: 'A', explanation: '数据在本地', difficulty: '简单'}]
            });
            tx.oncomplete = () => resolve('ok');
        };
        req.onerror = () => reject(req.error);
    })""")
    time.sleep(0.5)
    page.reload(wait_until="domcontentloaded")
    time.sleep(2)
    # 首页应显示最近一套（离线也能读 IndexedDB）
    lastset = page.is_visible("#last-set")
    print("5. 离线可读本地数据:", "PASS" if lastset else "FAIL")

    # 6. 离线点继续刷题
    page.click("#btn-continue")
    time.sleep(0.8)
    quiz_ok = page.is_visible("#view-quiz")
    q_text = page.text_content("#quiz-question") if quiz_ok else ""
    print("6. 离线可刷题:", "PASS" if quiz_ok and "离线时能刷" in q_text else "FAIL")

    print()
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
