#!/usr/bin/env python3
"""
Devin / Windsurf Better 汉化部署脚本

用法：
    python deploy.py deploy  -t "F:\\Devin"     # 部署
    python deploy.py restore -t "F:\\Devin"     # 恢复
"""

import argparse
import shutil
import sys
from pathlib import Path

# workbench.html 相对安装目录的路径
WORKBENCH_SUBPATH = Path("resources/app/out/vs/code/electron-browser/workbench")
WORKBENCH_FILE = "workbench.html"
BACKUP_SUFFIX = ".bak"

# 注入标记
PATCH_MARKER = "<!-- WS-BUBBLES-PATCH -->"
PATCH_SCRIPT = '<script src="./windsurf-better.js"></script>'

# 旧内联脚本的起止标记（用来清除原有的内联代码）
LEGACY_START = "<!-- WS-BUBBLES-PATCH -->"
LEGACY_END = "</script>"


def find_workbench_dir(root: Path) -> Path:
    """定位 workbench 目录"""
    target = root / WORKBENCH_SUBPATH
    if not target.exists():
        print(f"[错误] 找不到目录：{target}")
        sys.exit(1)
    return target


def deploy(root: Path, script_src: Path):
    wb_dir = find_workbench_dir(root)
    wb_file = wb_dir / WORKBENCH_FILE
    backup = wb_file.with_suffix(wb_file.suffix + BACKUP_SUFFIX)

    if not wb_file.exists():
        print(f"[错误] 找不到 {wb_file}")
        sys.exit(1)

    # 1. 备份
    if not backup.exists():
        shutil.copy2(wb_file, backup)
        print(f"[备份] {backup.name}")
    else:
        print(f"[备份] 已存在，跳过")

    # 2. 把 windsurf-better.js 复制过去
    dst_js = wb_dir / "windsurf-better.js"
    shutil.copy2(script_src, dst_js)
    print(f"[复制] windsurf-better.js -> {dst_js}")

    # 3. 处理 workbench.html
    content = wb_file.read_text(encoding="utf-8")

    # 3.1 删除旧的内联 script（如果有的话）
    if PATCH_MARKER in content:
        # 找到从 marker 开始，到 </script> 结束的整段
        start = content.find(PATCH_MARKER)
        end = content.find(LEGACY_END, start)
        if end != -1:
            end += len(LEGACY_END)
            # 检查是不是内联脚本
            segment = content[start:end]
            if "<script>" in segment:
                print("[清理] 发现旧的内联脚本，正在移除")
                content = content[:start] + content[end:]

    # 3.2 插入新的外部引用
    if PATCH_SCRIPT not in content:
        # 在 workbench.js 那行后面插入
        anchor = '<script src="./workbench.js" type="module"></script>'
        if anchor not in content:
            print("[错误] workbench.html 里找不到 workbench.js 引用，中止")
            sys.exit(1)
        new_block = f"\n\n{PATCH_MARKER}\n{PATCH_SCRIPT}\n"
        content = content.replace(anchor, anchor + new_block, 1)
        print("[注入] 已添加外部脚本引用")
    else:
        print("[注入] 已存在，跳过")

    wb_file.write_text(content, encoding="utf-8")
    print("\n✅ 部署完成，请完全退出并重启 Devin。")


def restore(root: Path):
    wb_dir = find_workbench_dir(root)
    wb_file = wb_dir / WORKBENCH_FILE
    backup = wb_file.with_suffix(wb_file.suffix + BACKUP_SUFFIX)

    if not backup.exists():
        print(f"[错误] 找不到备份文件 {backup}")
        sys.exit(1)

    shutil.copy2(backup, wb_file)
    print(f"[恢复] {wb_file.name} 已还原")

    dst_js = wb_dir / "windsurf-better.js"
    if dst_js.exists():
        dst_js.unlink()
        print(f"[清理] 已删除 windsurf-better.js")


def main():
    parser = argparse.ArgumentParser(description="Devin Better 汉化部署工具")
    parser.add_argument("action", choices=["deploy", "restore"])
    parser.add_argument("-t", "--target", required=True, help="Devin 安装目录，例如 F:\\Devin")
    parser.add_argument("-s", "--script", default="windsurf-better.js", help="本地脚本路径")
    args = parser.parse_args()

    root = Path(args.target)
    if not root.exists():
        print(f"[错误] 目录不存在：{root}")
        sys.exit(1)

    if args.action == "deploy":
        script_src = Path(args.script)
        if not script_src.exists():
            print(f"[错误] 找不到 {script_src}")
            sys.exit(1)
        deploy(root, script_src)
    else:
        restore(root)


if __name__ == "__main__":
    main()
