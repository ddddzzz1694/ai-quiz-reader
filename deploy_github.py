# -*- coding: utf-8 -*-
"""
部署到 GitHub Pages 脚本（供 gh 授权后使用）
流程：创建仓库 → 提交 static/ 内容到 gh-pages 分支 → 启用 Pages
用法：python deploy_github.py
"""
import os
import subprocess
import sys
import time

GH = os.path.expanduser("~/.codewhale/scripts/gh/bin/gh.exe")
REPO = "ai-quiz-reader"          # 仓库名
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".deploy_tmp")


def run(cmd, cwd=None, timeout=120):
    print(">>", cmd)
    r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True,
                       errors="replace", timeout=timeout)
    if r.returncode != 0:
        print("   !! stderr:", r.stderr.strip()[:300])
    else:
        print("   OK:", r.stdout.strip()[:200])
    return r.returncode == 0


def main():
    # 0. 确认授权
    r = subprocess.run([GH, "auth", "status"], capture_output=True, text=True, errors="replace")
    out = (r.stdout or "") + (r.stderr or "")
    if "scopes: none" in out:
        print("[!] GitHub 未授权（scopes: none）。请先运行 gh auth login --web --scopes repo 完成授权。")
        sys.exit(1)

    # 1. 创建仓库（已存在则跳过）
    run(f'"{GH}" repo create {REPO} --public --description "AI出题读书法 - 刷题 PWA"')

    # 2. 准备部署目录（只含正式文件，排除备份）
    if os.path.exists(WORK):
        import shutil
        shutil.rmtree(WORK)
    os.makedirs(WORK)
    for item in os.listdir(STATIC):
        if item.endswith(".bak") or item.endswith(".bak_20260825"):
            continue
        src = os.path.join(STATIC, item)
        dst = os.path.join(WORK, item)
        if os.path.isdir(src):
            import shutil
            shutil.copytree(src, dst)
        else:
            import shutil
            shutil.copy2(src, dst)
    print(f"[OK] 部署内容已准备到 {WORK}")

    # 3. git 初始化 + 提交 + 推送 gh-pages
    run("git init -b main", cwd=WORK)
    run('git config user.email "deploy@ai-quiz.local"', cwd=WORK)
    run('git config user.name "deploy"', cwd=WORK)
    run("git add -A", cwd=WORK)
    run('git commit -m "deploy: AI出题读书法 v1"', cwd=WORK)
    run(f'git remote add origin https://github.com/ddddzzz1694/{REPO}.git', cwd=WORK)
    run("git push -u origin main:gh-pages --force", cwd=WORK, timeout=180)

    # 4. 启用 GitHub Pages（gh-pages 分支）
    run(f'"{GH}" api repos/ddddzzz1694/{REPO}/pages -X POST -f source[branch]=gh-pages -f source[path]=/ --silent')
    print("\n[OK] 已提交，Pages 生效通常需 1-2 分钟。")
    print(f"    访问地址: https://ddddzzz1694.github.io/{REPO}/")

    # 5. 清理
    import shutil
    shutil.rmtree(WORK, ignore_errors=True)
    print("[OK] 临时目录已清理")


if __name__ == "__main__":
    main()
