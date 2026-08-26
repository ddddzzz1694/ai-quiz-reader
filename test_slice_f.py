# -*- coding: utf-8 -*-
"""切片F验证：手机通过局域网 IP 访问（模拟真实手机场景）"""
from playwright.sync_api import sync_playwright
import time

LAN_IP = "192.168.1.81"
URL = f"http://{LAN_IP}:8000/index.html"

with sync_playwright() as p:
    # 用安卓手机设备配置（Pixel 5 真机仿真）
    device = p.devices["Pixel 5"]
    browser = p.chromium.launch()
    ctx = browser.new_context(**device)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(URL, wait_until="networkidle")
    time.sleep(2)

    print(f"1. 通过局域网 IP 打开: PASS（{URL}）")
    title_ok = "AI出题读书法" in page.title()
    home_ok = page.is_visible("#view-home")
    print("2. 页面加载:", "PASS" if title_ok and home_ok else "FAIL")

    # 检查 PWA 可安装性（manifest 可访问）
    manifest_ok = page.evaluate("""() => fetch('/manifest.webmanifest').then(r => r.ok)""")
    print("3. manifest 可访问(可装主屏幕):", "PASS" if manifest_ok else "FAIL")

    # 检查 SW 注册（离线能力）
    sw_ok = page.evaluate("""() => new Promise((res) => {
        if (!('serviceWorker' in navigator)) return res('no-support');
        navigator.serviceWorker.ready.then(() => res('ready')).catch(e => res('err:' + e.message));
    })""")
    print("4. Service Worker(离线能力):", "PASS" if sw_ok == "ready" else "FAIL " + str(sw_ok))

    # 页面是否全屏 PWA 模式（display-mode）
    dm = page.evaluate("() => matchMedia('(display-mode: standalone)').matches")
    print("5. PWA standalone 模式:", "PASS" if dm else "INFO（浏览器标签页模式，安装后才会全屏）")

    # 手机 UI 检查：底部导航可见 + 按钮够大
    nav_ok = page.is_visible("#tabbar")
    btn_size = page.evaluate("""() => {
        const b = document.querySelector('#btn-generate');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
    }""")
    print("6. 底部导航:", "PASS" if nav_ok else "FAIL")
    print("7. 生成按钮尺寸:", btn_size, "（建议高度>=48px 适合手指点击）",
          "PASS" if btn_size and btn_size["h"] >= 48 else "FAIL")

    print()
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
