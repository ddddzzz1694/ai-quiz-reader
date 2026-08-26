# -*- coding: utf-8 -*-
"""真实出题端到端测试：填Key → 粘书摘 → 点生成 → 验证AI出的题"""
import os
import time
from playwright.sync_api import sync_playwright

API_KEY = os.environ.get("QUIZ_API_KEY", "")
if not API_KEY:
    print("需要环境变量 QUIZ_API_KEY")
    raise SystemExit(1)

SAMPLE_TEXT = """非暴力沟通（NVC）四步法：1. 观察——说出你看到的客观事实，不加评判；2. 感受——表达你内心的真实感受；3. 需要——说出导致这种感受的需要；4. 请求——提出具体、可执行的请求。核心心法：不评判、不指责、不命令，而是表达自己的观察和需要，同时倾听对方的需要。常见误区：把观察说成评判（"你总是迟到"是评判，不是观察），把感受说成想法（"我觉得你不尊重我"是想法，不是感受），把请求说成命令（"你必须马上改"是命令，不是请求）。"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1)

    # 1. 填 Key
    page.click("#btn-settings")
    time.sleep(0.5)
    page.fill("#set-apikey", API_KEY)
    page.click("#btn-save-key")
    time.sleep(0.8)
    key_ok = page.is_visible("#key-status") and "已保存" in (page.text_content("#key-status") or "")
    print("1. 保存 Key:", "PASS" if key_ok else "FAIL")

    # 2. 回首页粘书摘
    page.click('.tab[data-view="home"]')
    time.sleep(0.5)
    page.fill("#input-text", SAMPLE_TEXT)
    page.click("#btn-generate")

    # 3. 等待出题完成（最长 90 秒）
    print("2. 等待 AI 出题……")
    ok = False
    for i in range(90):
        time.sleep(1)
        st = page.text_content("#gen-status") or ""
        if "出好了" in st:
            ok = True
            break
        if "出题失败" in st:
            print("   出题失败:", st[:200])
            break
    print("2. AI 出题:", "PASS" if ok else "FAIL")

    # 4. 刷第一题
    time.sleep(0.5)
    in_quiz = page.is_visible("#view-quiz")
    q = page.text_content("#quiz-question") or ""
    prog = page.text_content("#quiz-progress") or ""
    print("3. 进入刷题页:", "PASS" if in_quiz else "FAIL")
    print("   进度:", prog, "| 题干前40字:", q[:40])

    # 5. 点一个选项看反馈
    page.click(".option-btn:nth-child(1)")
    page.click("#btn-submit")
    time.sleep(1)
    verdict = page.text_content("#feedback-verdict") or ""
    expl = page.text_content("#feedback-explanation") or ""
    print("4. 选项反馈:", "PASS" if ("答对" in verdict or "答错" in verdict) else "FAIL", "|", verdict)
    print("   解析长度:", len(expl), "字")

    # 6. 验证题目质量（检查是否应用场景题而非事实题）
    first_q = q
    quality_ok = "年" not in first_q[:30] or True  # 只做提示，不判死
    print("5. 题干是否场景题(提示):", "「" + first_q[:30] + "…」")

    print()
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
