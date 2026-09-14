# Devin Desktop Chinese
Devin Desktop（Windsurf）汉化补充与说明

本仓库提供 windsurf-better.js 脚本，用于为 Devin Desktop/ Windsurf Desktop补充界面汉化，并支持一键部署或手动替换。

📦 仓库内容
文件	作用
windsurf-better.js	增强脚本，含汉化、气泡、自动继续等功能
deploy.py	一键部署 / 恢复脚本（可选）
README.md	说明文档
🚀 方式一：一键部署（推荐）
前置条件
Windows 系统

已安装 Python 3.6+

已安装 Devin（Windsurf）

部署
bash
python deploy.py deploy -t "F:\Devin"
把 F:\Devin 换成你的实际安装目录。

脚本会自动完成：

备份 workbench.html 为 workbench.html.bak

把 windsurf-better.js 复制到 workbench 目录

移除旧的内联脚本（如果有）

在 workbench.js 之后插入外部引用

恢复
bash
python deploy.py restore -t "F:\Devin"
会还原 workbench.html 并删除 windsurf-better.js。

🛠️ 方式二：手动部署（不用 Python）
如果你不想用脚本，也可以手动操作，步骤同样简单。

1. 找到 workbench 目录
通常位于：

text
F:\Devin\resources\app\out\vs\code\electron-browser\workbench\
2. 备份 workbench.html
复制一份 workbench.html 为 workbench.html.bak，方便恢复。

3. 把 windsurf-better.js 复制到该目录
从本仓库下载 windsurf-better.js，放到上面那个 workbench 目录里。

4. 修改 workbench.html
用 Notepad++ 打开 workbench.html，找到下面这一行：

html
<script src="./workbench.js" type="module"></script>
在它下面添加：

html
<!-- WS-BUBBLES-PATCH -->
<script src="./windsurf-better.js"></script>
⚠️ 重要：workbench.js 那一行绝对不能删或改名，否则 Devin 会白屏打不开。

5. 如果 HTML 里还有旧的内联脚本
如果原来的 workbench.html 里有一段类似这样的几千行内联脚本：

html
<!-- WS-BUBBLES-PATCH -->
<script>
  (function () { ... })();
</script>
必须整段删除，否则会和新的外部脚本重复执行，导致界面异常。

6. 重启 Devin
完全退出 Devin（任务栏也要退），重新打开。

✅ 验证是否生效
打开 DevTools（Ctrl+Shift+P → Developer: Toggle Developer Tools），在左上角 frame 下拉框选择 vscode-app，执行：

js
window.__wsBetterVersion
返回 '1.5.7' 说明脚本已加载。

📝 补充汉化词条
如果需要补充新的汉化词条：

打开 windsurf-better.js

搜索 ['Switch agent (Ctrl+\')', '切换智能体 (Ctrl+\')'],

在它下面、]); 上面添加新词条：

js
["英文原文", "中文翻译"],
动态数字文本加到 REGEX_TRANSLATIONS 里：

js
[/^Scans\s+(\d+)$/i, '扫描 $1'],
保存后验证语法：

bash
node --check "路径/windsurf-better.js"
无输出 = 正确，可以重启 Devin。

⚠️ 注意事项
不要动 workbench.js，它是 Devin 官方文件，丢失会导致白屏。

单词大小写必须与界面完全一致，否则匹配不到。

模型名、品牌名（如 SWE-1.6 Slow、Sentry、Slack）不翻译。

Devin 更新后会覆盖 workbench.html，需要重新部署（自动或手动）。

部分页面文本由 iframe / Shadow DOM 渲染，静态匹配可能无效，属正常现象。

如果遇到白屏，用备份的 workbench.html.bak 覆盖回去即可恢复。

📌 已知限制
无法翻译被拆分成多个 DOM 节点的文本

无法翻译 iframe 内的内容

Devin 更新后需要重新部署

📄 项目来源
核心脚本 windsurf-better.js 来自社区项目 windsurf-autoContinue（版本 v1.5.7）。

在此基础上补充了界面汉化词条，并改为外部脚本引用方式加载。
