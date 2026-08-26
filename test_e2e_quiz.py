# -*- coding: utf-8 -*-
"""端到端刷题流程测试：注入模拟题集 → 刷题 → 验证持久化"""
from playwright.sync_api import sync_playwright
import time

INJECT_JS = """
() => new Promise((resolve, reject) => {
    const req = indexedDB.open('quiz_app', 1);
    req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', {keyPath:'id'});
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', {keyPath:'id'});
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', {keyPath:'key'});
    };
    req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('sets', 'readwrite');
        const set = {
            id: 'testset1',
            title: '测试题集：非暴力沟通',
            source: '非暴力沟通四步法',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            questions: [
                {question:'同事迟到且没道歉，你很生气。按非暴力沟通原则，以下哪句开场白最合适？', options:['你怎么又迟到？','我看到你迟到了15分钟，我感到有些担忧，因为我需要确保会议准时开始，你愿意解释一下原因吗？','你总是这样，我受够了。','算了，你以后注意点。'], answer:'B', explanation:'非暴力沟通四步是观察-感受-需要-请求。B包含全部四步。A是评判，C是情绪发泄，D是回避。', difficulty:'中等'},
                {question:'家人忘记了你交代的事，你很失望。非暴力沟通的正确做法是？', options:['你怎么总是忘事！','算了，下次我自己来。','我感到失望，因为我需要被重视，你愿意下次提醒自己记一下吗？','你根本不在乎我说的话。'], answer:'C', explanation:'C表达感受和需要并提出请求，符合非暴力沟通。', difficulty:'简单'},
                {question:'朋友借钱不还，你心里不舒服。以下哪个是观察的表述？', options:['你是个不守信用的人','你借了3000元，约定上月还，还没还','你总是这样，我受够了','你根本不在乎我'], answer:'B', explanation:'观察是陈述事实不带评判。B是客观事实，其余都是评判。', difficulty:'困难'}
            ]
        };
        tx.objectStore('sets').put(set);
        tx.oncomplete = () => resolve('injected');
    };
    req.onerror = () => reject(req.error);
})
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)

    page.evaluate(INJECT_JS)
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1)

    print("1. 首页显示最近一套:", "PASS" if page.is_visible("#last-set") else "FAIL")
    page.click("#btn-continue")
    time.sleep(0.5)
    print("2. 进入刷题页:", "PASS" if page.is_visible("#view-quiz") else "FAIL")
    progress = page.text_content("#quiz-progress")
    print("3. 进度显示:", "PASS" if "第 1/3 题" in progress else "FAIL " + progress)
    q = page.text_content("#quiz-question")
    print("4. 题干:", "PASS" if "迟到" in q else "FAIL")

    page.click(".option-btn:nth-child(1)")
    page.click("#btn-submit")
    time.sleep(0.8)
    verdict = page.text_content("#feedback-verdict")
    print("5. 答错反馈:", "PASS" if "答错了" in verdict else "FAIL " + verdict)
    expl = page.text_content("#feedback-explanation")
    print("6. 解析显示:", "PASS" if "非暴力沟通" in expl else "FAIL")
    score = page.text_content("#quiz-score")
    print("7. 计数(错1):", "PASS" if "错 1" in score else "FAIL " + score)

    page.click("#btn-next")
    time.sleep(0.3)
    page.click(".option-btn:nth-child(3)")
    page.click("#btn-submit")
    time.sleep(0.8)
    verdict2 = page.text_content("#feedback-verdict")
    print("8. 答对反馈:", "PASS" if "答对了" in verdict2 else "FAIL " + verdict2)
    score2 = page.text_content("#quiz-score")
    print("9. 计数(对1错1):", "PASS" if ("对 1" in score2 and "错 1" in score2) else "FAIL " + score2)

    page.click("#btn-next")
    time.sleep(0.3)
    page.click(".option-btn:nth-child(2)")
    page.click("#btn-submit")
    time.sleep(0.8)
    page.click("#btn-next")
    time.sleep(0.5)
    done = page.text_content("#done-stats")
    print("10. 完成页统计:", "PASS" if ("对 2" in done and "错 1" in done) else "FAIL " + done)

    page.reload(wait_until="networkidle")
    time.sleep(1)
    page.click('.tab[data-view="data"]')
    time.sleep(0.8)
    stats_text = page.text_content("#data-stats")
    print("11. 刷新后数据保留:", "PASS" if ("已答题" in stats_text and "3" in stats_text) else "FAIL")

    print()
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
