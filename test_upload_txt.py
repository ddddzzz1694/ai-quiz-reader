# -*- coding: utf-8 -*-
"""txt 上传功能测试：选文件→内容填入输入框"""
from playwright.sync_api import sync_playwright
import time, os

# 准备测试文件（UTF-8）
test_txt = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_test_upload.txt")
with open(test_txt, "w", encoding="utf-8") as f:
    f.write("非暴力沟通四步法：观察、感受、需要、请求。这是测试内容，用来验证上传功能是否正常把文件内容读入输入框。\n" * 5)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://localhost:8000/index.html", wait_until="networkidle")
    time.sleep(1.5)

    # 1. 上传按钮存在
    print("1. 上传按钮存在:", "PASS" if page.is_visible("#btn-upload-txt") else "FAIL")
    # 2. 选择文件
    page.set_input_files("#upload-file", test_txt)
    time.sleep(1.5)
    val = page.input_value("#input-text")
    print("2. 文件内容读入输入框:", "PASS" if len(val) > 100 else f"FAIL len={len(val)}")
    name = page.text_content("#upload-name") or ""
    print("3. 文件名提示:", "PASS" if "已读入" in name else f"FAIL {name[:50]}")
    # 4. 读入后点生成按钮有反应（提示没填Key或正常出题）
    page.click("#btn-generate")
    time.sleep(1)
    status = page.text_content("#gen-status") or ""
    print("4. 生成按钮有反应:", "PASS" if status.strip() else "FAIL(空)")
    print("   状态:", status.strip()[:60])
    print("5. 错误:", errors[:3] if errors else "无")
    browser.close()
os.remove(test_txt)
