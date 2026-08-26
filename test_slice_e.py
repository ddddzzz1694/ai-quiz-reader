# -*- coding: utf-8 -*-
"""切片E验证：导出/导入 + 提示词管理（保存存档 + 回滚）"""
from playwright.sync_api import sync_playwright
import time
import json
import io

INJECT = """
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
        tx.objectStore('sets').put({
            id: 'sete1', title: '导出测试题集', source: 'x',
            createdAt: Date.now(), updatedAt: Date.now(),
            questions: [{question:'导出测试题', options:['A','B','C','D'], answer:'A', explanation:'解析', difficulty:'简单'}]
        });
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
    page.evaluate(INJECT)
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1)

    # ========== 1. 导出（按钮在设置页） ==========
    page.click('.tab[data-view="settings"]')
    time.sleep(0.8)
    with page.expect_download() as dl_info:
        page.click("#btn-export")
    download = dl_info.value
    path = download.path()
    content = io.open(path, encoding="utf-8").read()
    data = json.loads(content)
    print("1. 导出文件:", "PASS" if data.get("app") == "AI出题读书法" else "FAIL")
    print("   导出内容: 题集", len(data.get("sets", [])), "套 / 记录", len(data.get("records", [])), "条")
    exported_sets = data.get("sets", [])

    # ========== 2. 导入（模拟换设备：清空后导入） ==========
    page.evaluate("""() => new Promise((res) => {
        const req = indexedDB.open('quiz_app', 1);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['sets','records','settings'], 'readwrite');
            tx.objectStore('sets').clear();
            tx.objectStore('records').clear();
            tx.objectStore('settings').clear();
            tx.oncomplete = () => { db.close(); res('cleared'); };
        };
    })""")
    time.sleep(0.5)
    page.reload(wait_until="networkidle")
    time.sleep(1)
    # 用 set_input_files 注入导出文件
    import tempfile, os
    tmp = os.path.join(tempfile.gettempdir(), "quiz_export_test.json")
    with io.open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    page.on("dialog", lambda d: d.accept())  # 处理 alert
    page.click('.tab[data-view="settings"]')
    time.sleep(0.8)
    page.click("#btn-import")
    page.set_input_files("#import-file", tmp)
    time.sleep(1.5)
    page.click('.tab[data-view="data"]')
    time.sleep(1)
    stats = page.text_content("#data-stats") or ""
    print("2. 导入后数据:", "PASS" if "1" in stats and "题集" in stats else "FAIL", "|", stats.replace("\n", " ")[:60])

    # ========== 3. 提示词保存（改规则 → 自动存档旧版） ==========
    page.click('.tab[data-view="prompt"]')
    time.sleep(1)
    orig = page.input_value("#prompt-text")
    # 修改规则（追加一行）
    page.fill("#prompt-text", orig + "\n\n（测试追加行）")
    page.click("#btn-save-prompt")
    time.sleep(2)
    status = page.text_content("#prompt-status") or ""
    print("3. 保存规则:", "PASS" if "已保存" in status else "FAIL", "|", status.strip()[:60])

    # ========== 4. 历史版本列表（等待异步渲染完成） ==========
    try:
        page.wait_for_selector('[data-restore="1"]', timeout=8000)
    except Exception:
        pass
    time.sleep(1)
    hist = page.text_content("#prompt-history") or ""
    has_hist = "回滚" in hist
    print("4. 历史版本区(含回滚按钮):", "PASS" if has_hist else "FAIL", "|", hist.strip().replace("\n", " ")[:80])

    # ========== 5. 回滚到旧版 ==========
    # 先点"查看"读第一个存档版本内容作为基准，再回滚对比
    rollback_btn = page.locator('[data-restore="1"]').first
    if rollback_btn.count() > 0:
        # 找到第一个存档项的"查看"按钮并点击
        first_hist = page.locator('.hist-item', has=page.locator('[data-restore="1"]')).first
        first_hist.locator('button', has_text="查看").click()
        time.sleep(1)
        base_content = page.input_value("#prompt-text")
        page.on("dialog", lambda d: d.accept())
        rollback_btn.click()
        time.sleep(2)
        restored = page.input_value("#prompt-text")
        print("5. 回滚:", "PASS" if restored == base_content else "FAIL",
              f"| 回滚后==目标版本: {restored == base_content}（长度 {len(restored)} vs {len(base_content)}）")
    else:
        print("5. 回滚: SKIP（无存档版本可回滚——说明存档逻辑可能没触发）")

    print()
    print("JS 错误:", "无" if not errors else errors[:3])
    browser.close()
