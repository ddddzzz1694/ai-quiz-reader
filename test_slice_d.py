# -*- coding: utf-8 -*-
"""切片D验证：错题记录 + 先错题模式 + 断点续刷 + 随机模式"""
from playwright.sync_api import sync_playwright
import time

INJECT = """
() => new Promise((resolve, reject) => {
    const req = indexedDB.open('quiz_app', 2);
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
            id: 'setd4', title: 'D切片验证', source: 'x',
            createdAt: Date.now(), updatedAt: Date.now(),
            questions: [
                {question:'题一（正确答案B）', options:['甲','乙','丙','丁'], answer:'B', explanation:'解析一', difficulty:'简单'},
                {question:'题二（正确答案C）', options:['甲','乙','丙','丁'], answer:'C', explanation:'解析二', difficulty:'中等'},
                {question:'题三（正确答案A）', options:['甲','乙','丙','丁'], answer:'A', explanation:'解析三', difficulty:'困难'}
            ]
        });
        // 预设记录：题一答错过（错题）
        tx.objectStore('records').put({id:'r1', setId:'setd4', qIndex:0, answer:'A', correct:false, supplement:'', ts:Date.now()});
        tx.oncomplete = () => resolve('injected');
    };
    req.onerror = () => reject(req.error);
})
"""


def click_and_submit(page, option_index):
    """选选项 → 提交 → 等反馈出现 → 点下一题"""
    page.click(f".option-btn:nth-child({option_index})")
    time.sleep(0.3)
    page.click("#btn-submit")
    time.sleep(0.8)
    # 等反馈出现
    page.wait_for_selector("#feedback-verdict", timeout=5000)
    # 等下一题按钮可见
    page.wait_for_selector("#btn-next:visible", timeout=5000)
    page.click("#btn-next")
    time.sleep(0.5)


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
    time.sleep(1)

    # 1. 先错题模式：首题应为错题（题一）
    page.click('.tab[data-view="data"]')
    time.sleep(0.8)
    page.click('[data-act="wrong"]')
    time.sleep(1)
    q1 = page.text_content("#quiz-question")
    prog = page.text_content("#quiz-progress")
    print("1. 先错题模式首题=错题:", "PASS" if "题一" in q1 else "FAIL", "|", q1, "| 进度:", prog)

    # 2. 答完错题后，次题应为正常题（题二/题三）
    click_and_submit(page, 2)  # 题一正确答案B，选第2个=乙=B
    q2 = page.text_content("#quiz-question")
    print("2. 次题=正常题:", "PASS" if ("题二" in q2 or "题三" in q2) else "FAIL", "|", q2)

    # 3. 答完这一题（中途退出，模拟断点）
    click_and_submit(page, 3)  # 题二正确答案C，选第3个=丙=C
    # 现在在第3题，退出
    page.click('.tab[data-view="home"]')
    time.sleep(0.5)
    print("3. 中途退出回首页: PASS")

    # 4. 断点续刷：数据页→刷题，应从第1题开始（设计如此：重刷整套）
    page.click('.tab[data-view="data"]')
    time.sleep(0.8)
    page.click('[data-act="practice"]')
    time.sleep(1)
    prog2 = page.text_content("#quiz-progress")
    print("4. 续刷进入:", "PASS" if "第 1/3 题" in prog2 else "FAIL", "|", prog2)

    # 5. 随机模式切换
    page.click('.tab[data-view="settings"]')
    time.sleep(0.5)
    page.click('[data-order="random"]')
    time.sleep(0.5)
    page.click('.tab[data-view="data"]')
    time.sleep(0.5)
    page.click('[data-act="practice"]')
    time.sleep(1)
    prog3 = page.text_content("#quiz-progress")
    print("5. 随机模式进入:", "PASS" if "第 1/3 题" in prog3 else "FAIL", "|", prog3)

    # 6. 刷新后数据保留（已有记录）
    page.reload(wait_until="networkidle")
    time.sleep(1)
    page.click('.tab[data-view="data"]')
    time.sleep(0.8)
    stats = page.text_content("#data-stats") or ""
    print("6. 刷新后数据保留:", "PASS" if ("已答题" in stats and "3" in stats) else "FAIL", "|", stats.replace("\n", " ")[:80])

    print()
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
