# -*- coding: utf-8 -*-
"""
AI出题读书法 - 本地服务器
作用：把本目录变成一个网页服务，手机/电脑通过浏览器访问。
启动：双击 启动.bat 或命令行运行 python app.py

额外功能：
- POST /api/save_prompt  保存提示词（自动把旧版存档到 prompts/archive/）
- GET  /api/prompt_history 列出所有历史版本
- GET  /api/prompt?file=xxx 读取某个历史版本内容
"""
import http.server
import io
import json
import os
import re
import socketserver
import time
import urllib.parse

PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(DIR, "static")
PROMPT_FILE = os.path.join(DIR, "prompts", "generate.txt")
ARCHIVE_DIR = os.path.join(DIR, "prompts", "archive")

# 常见文件类型映射（让浏览器正确识别）
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".ico": "image/x-icon",
}


def api_ok(handler, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def api_err(handler, code, msg):
    body = json.dumps({"error": msg}, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def end_headers(self):
        # 允许局域网内手机访问（PWA 需要）
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, "application/octet-stream")

    # ---------- API ----------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/save_prompt":
            self.handle_save_prompt()
        else:
            api_err(self, 404, "接口不存在")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/prompt_history":
            self.handle_prompt_history()
            return
        if parsed.path == "/api/prompt":
            qs = urllib.parse.parse_qs(parsed.query)
            fname = (qs.get("file") or [""])[0]
            self.handle_prompt_read(fname)
            return
        super().do_GET()

    def handle_save_prompt(self):
        """保存新提示词：先存档旧版，再写新内容"""
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            data = json.loads(raw)
            new_text = (data.get("prompt") or "").strip()
            if not new_text:
                api_err(self, 400, "提示词内容为空")
                return
            os.makedirs(ARCHIVE_DIR, exist_ok=True)
            # 1) 若当前有旧版，先存进 archive
            if os.path.exists(PROMPT_FILE):
                old = io.open(PROMPT_FILE, encoding="utf-8").read()
                if old.strip() != new_text:
                    ts = time.strftime("%Y-%m-%d_%H-%M")
                    ver = 1
                    while True:
                        fname = f"generate_{ts}_v{ver}.txt"
                        if not os.path.exists(os.path.join(ARCHIVE_DIR, fname)):
                            break
                        ver += 1
                    with io.open(os.path.join(ARCHIVE_DIR, fname), "w", encoding="utf-8") as f:
                        f.write(old)
            # 2) 写新内容
            with io.open(PROMPT_FILE, "w", encoding="utf-8") as f:
                f.write(new_text)
            api_ok(self, {"ok": True, "message": "已保存，旧版本已自动存档"})
        except Exception as e:
            api_err(self, 500, f"保存失败: {e}")

    def handle_prompt_history(self):
        """列出所有历史版本（含当前）"""
        items = []
        if os.path.exists(PROMPT_FILE):
            items.append({
                "file": "generate.txt",
                "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(PROMPT_FILE))),
                "current": True,
            })
        if os.path.isdir(ARCHIVE_DIR):
            for fn in sorted(os.listdir(ARCHIVE_DIR), reverse=True):
                if fn.endswith(".txt"):
                    p = os.path.join(ARCHIVE_DIR, fn)
                    items.append({
                        "file": fn,
                        "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p))),
                        "current": False,
                    })
        api_ok(self, {"items": items})

    def handle_prompt_read(self, fname):
        """读取提示词内容（file 参数：generate.txt 或 archive 里的文件名）"""
        safe = re.sub(r"[^A-Za-z0-9_\-\.]", "", fname or "")
        if not safe or safe == "generate.txt":
            path = PROMPT_FILE
        else:
            path = os.path.join(ARCHIVE_DIR, safe)
        if not os.path.exists(path):
            api_err(self, 404, "文件不存在")
            return
        text = io.open(path, encoding="utf-8").read()
        api_ok(self, {"file": safe, "content": text})


def get_lan_ip():
    """获取电脑在局域网里的 IP（手机要访问这个地址）"""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    ip = get_lan_ip()
    print("=" * 52)
    print("  AI出题读书法  已启动")
    print(f"  电脑上打开: http://localhost:{PORT}")
    print(f"  手机上打开: http://{ip}:{PORT}   (手机连同一个WiFi)")
    print("  按 Ctrl+C 停止服务")
    print("=" * 52)
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已停止")
