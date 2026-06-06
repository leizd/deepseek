# DeepSeek Mobile

![版本](https://img.shields.io/badge/version-1.9.1-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-green)
![许可证](https://img.shields.io/badge/license-MIT-black)

DeepSeek Mobile 是一个**手机优先、本地优先**的 DeepSeek AI 客户端。它把一套 Web 前端和一个本机 Python 后端打包在一起：桌面端双击即可打开内嵌 WebView 的本地应用窗口，Android 端可打包成 APK，普通浏览器也能直接访问。后端运行在你自己的机器上，负责转发 DeepSeek API，并在本地完成联网搜索、文件解析、OCR、图片视觉理解、长期记忆、项目文档库、函数工具调用、端云协同推理、本地 RAG 检索、链路追踪和 API 网关韧性——除了你主动发往 DeepSeek / Tavily 的请求，数据都留在本机。

> 想看逐版本的变更记录，请见 [CHANGELOG.md](CHANGELOG.md)。本文档只描述**当前版本**的能力与用法，不再堆叠历史更新日志。

## 亮点

- **一套后端，三种形态**：同一份 Python 后端既能作为桌面本地应用窗口（内嵌 WebView，不跳外部浏览器）运行，也能打包成 Android APK，或作为本机 / 局域网浏览器服务启动。
- **本地优先、数据不出端**：对话历史、草稿、文件缓存、向量索引、长期记忆、追踪与缓存全部保存在本机；DeepSeek / Tavily API Key 可以只用环境变量、不落库。
- **不只是聊天**：联网搜索、读图、读文档、做 PPT / Word / PDF / 思维导图、多 Agent 协作、端侧推理都是内建能力，而不是外挂。

## 核心能力

### 对话与推理
- 支持 `deepseek-v4-pro` 与 `deepseek-v4-flash`，默认 `deepseek-v4-pro`；快速模式 / 专家模式一键切换，专家模式默认开启深度思考。
- 推理过程与最终回复均流式输出，流式阶段会区分显示「思考中 / 调用工具中 / 搜索中 / Agent 工作中 / 生成中」。
- 支持暂停、中断、继续、重新生成；可编辑历史用户消息后重发，也可以从任意助手回复创建分支，保留旧走向继续探索。
- Markdown 全面渲染：标题、列表、引用、表格、链接、代码块（行号 / 超长折叠 / 复制 / 下载 / 检测到本地路径时 `vscode://file/...` 打开）、行内与块级公式（本地 KaTeX，不依赖外部 CDN）、`mermaid` 流程图，以及把表格数值列一键转成柱状 / 折线 / 饼图。

### 多 Agent 协作
- 开启多 Agent 后，Leader 拆解任务，Researcher / Coder / Reasoner / Critic 等角色按声明的 `depends_on` 做拓扑分层、同层并行，再由 Synthesizer 综合成最终回答。
- **可恢复 Agent Run**：每次运行持久化到 `.agent-runs/`，事件带 `runId` / `index` / `createdAt`，刷新页面或断线后可从最后一个事件继续恢复；Activity 面板支持单 Agent 重跑或只重新综合最终回答。
- Critic 可点名一个前序 worker 带反馈重跑一轮再综合；token 预算护栏 `MULTI_AGENT_TOKEN_BUDGET` 超额后不再启动后续层，但综合阶段始终执行，保证总能拿到最终答案。

### 联网搜索
- 关闭 / 自动 / 强制三档联网搜索；自动模式由模型决定本轮是否联网。
- 多轮互补搜索 + 结果去重重排 + 本地 `.search-cache` 缓存；模型也可以通过 `web_search` 工具按需检索，并对搜索结果来源做二次精读。
- Tavily API Key 可来自服务端环境变量，也可来自页面设置中的本轮请求；刷新、中断或断线留下的未完成搜索轮会自动收尾为明确的失败状态。

### 文件理解与文档工作台
- 多文件上传，支持文本 / Markdown / CSV / JSON / 代码 / RTF / HTML / DOCX / XLSX / PPTX / EPUB / PDF，以及 PNG / JPG / WebP / BMP / TIFF / GIF 等图片；流式 multipart 解析，默认单文件最大 200 MB、单次请求体最大 220 MB。
- 文件在本地后端解析、分块、缓存，聊天请求只发送 `fileId` 等元数据；提问时按问题从缓存检索相关片段，而不是把整份文件硬塞给模型。
- 文档阅读工作台：上传 PDF / 图片 / 文本后点「预览」，宽屏会切换成左侧文档对话、右侧原文逐页阅读的分栏视图，支持翻页 / 缩放 / 目录缩略图 / 跨页搜索 / 框选区域转图片提问 / 翻译全文 / 一键总结 / 大纲 / 追问 / 脑图。
- 回答引用回链：模型使用 `[^F1-2]` 这类引用标记时，前端会渲染为可点击 pin 并打开对应文件片段预览。

### 图片视觉与 OCR
- **图片视觉理解**：上传图片默认交给 `deepseek-v4-pro` 多模态模型理解，可读图、看图答题、识别公式与图表，而不是只提取纯文字。
- OCR 作为「提取文字」的降级路径：优先调用 DeepSeek API 转写图片，API 不可用时桌面端回退本地 Tesseract / Windows OCR，Android APK 走内置 ML Kit；扫描版 PDF 逐页渲染识别，公式截图可接入 `pix2tex` 等本地公式 OCR 工具择优。

### 生成式产物
- DeepSeek function calling 可调用本地工具直接产出可下载文件：`create_pptx` 用 `python-pptx` 渲染真实 `.pptx`（自动目录页并在卡片 / 流程 / 对比 / 总结等版式间切换）、`create_document` 生成排版精美的 `.docx` / `.pdf`、`create_mindmap` 生成可下载 `.svg` 思维导图并在正文内嵌预览。
- 还内建 `python_eval`、`search_files`、`fetch_url`、`web_search`、数据转换、图表、提醒、记忆等工具；终态文件工具执行成功后会直接回传本地下载链接，不再把完整工具结果二次发回 DeepSeek 总结，避免拉低 prompt cache 命中率。

### 端云协同推理
- 可选接入本地端侧模型（`EDGE_INFERENCE_ENABLED=1` + `llama-cpp-python` 或 MLC-LLM 后端 + GGUF 路径）：`edgeMode=auto` 会把闲聊 / 概括 / 改写 / 翻译等短任务优先路由到本地模型，代码 / 数学 / 联网搜索 / 文档生成 / 多 Agent / 图片任务继续走云端 DeepSeek。
- 云端连接失败时，简单任务可自动回退本地端侧模型；没有云端 API Key 但本地模型可用时，也能进行普通对话。

### 本地数据层与可观测性
- **本地 RAG**：`.file-cache`、`.projects` 和 `.memory` 会同步进 `.local-rag/rag.sqlite3`，默认纯 SQLite + 哈希 embedding 零依赖；安装可选依赖后可启用 `sqlite-vec` 向量表与 ONNX Runtime 本地 embedding 流水线。
- **链路追踪**：每轮普通聊天、端侧推理和多 Agent DAG 都会生成 `traceId` 写入 `.traces/`，助手消息可打开 trace waterfall 查看各节点耗时、token 消耗和 prompt cache 命中率。
- **语义缓存**：无工具、无搜索、无附件的请求会在调用 DeepSeek 前查 `.semantic-cache/`，相似度达到阈值时直接返回本地缓存结果。
- **API 网关韧性**：Context Manager 稳定 system prompt 与工具定义前缀，最大化 DeepSeek Prefix Cache 命中；SQLite 请求队列在断网、超时、429 / 502 / 503 / 504 等可重试失败时退避重试，手机息屏或短暂断网后，后台 Agent 工作流可等网络恢复再续跑。

### 长期记忆
- 用「记住：…」保存偏好、项目背景、长期任务，用「忘记 …」删除；模型也可以在回答中提出值得保存的记忆建议，需用户确认才写入，不会自动保存。
- 支持 `global`、`project:<id>` 和 `seek:<id>` 作用域，保存时做轻量冲突检测；API Key、token、密码、证件号、银行卡等敏感内容会被拦截，不进入长期记忆。数据保存在本地 `.memory/memories.json`。

### Seek 助手
- 创建本地自定义助手，保存名称、简介、专属指令、开场提示和参考文件，对话中自动注入对应系统指令与参考资料；参考文件随消息快照保存，继续生成 / 重新生成 / 编辑重发时使用消息当时的 Seek，而不是当前面板选中的 Seek。
- 自定义 Seek 最多 40 个、名称不可重复，支持导入 / 导出 JSON，推荐 Seek 可一键复制为自定义后继续编辑。

### 前端体验
- PWA：manifest、SVG / PNG / maskable 图标和 Service Worker 齐全，可安装到手机桌面；支持 Share Target，从系统分享菜单导入文章标题、URL、文本、图片或文档。
- 四种视觉风格（ChatGPT 极简白 / LinearFlow 深色 / Notion 暖色 / Arc 渐变玻璃）× 浅色 / 深色 / 跟随系统，另有可选的 Gemini 风格皮肤；设置保存在浏览器本地，首屏渲染前自动应用，减少主题闪烁。
- Web Speech 语音输入与本地朗读、拖拽 / 粘贴上传、选区引用提问、未发送草稿自动保存、本地提醒（Web Notification）、命令面板（`Ctrl/Cmd+K`）与全局快捷键、移动端动效反馈与无障碍 live region。
- 后端不可用时进入离线模式，可继续查看和搜索本地历史，但不能发送新消息。

## 快速开始

### 方式 1（推荐）：本地桌面应用窗口

1. 安装一次 Python 依赖：
   ```powershell
   python -m pip install -r requirements.txt
   ```
2. **Windows** 直接双击 `launch.bat`，**macOS / Linux** 双击或执行 `./launch.sh`，会打开 DeepSeek Mobile 本地应用窗口。
3. 在应用右上角设置里填写 DeepSeek API Key（必填）和 Tavily API Key（可选）；也可以先通过环境变量提供 Key。

桌面应用会自动使用带 `desktop=1` 的本地 token 入口完成认证，双击后不需要手动复制 token 链接；如果改用浏览器访问命令行服务，仍使用终端打印的 `?token=...` 地址。需要手动选择端口、局域网模式或查看服务日志时，运行 `python launch.py --gui` 或 `DeepSeekMobile.exe --gui` 打开旧 GUI 启动器。

### 方式 2：手机本机直接运行

Android 手机上可以用 Termux 或 Pydroid 这类 Python 环境直接跑后端，然后在同一台手机的浏览器里打开本机地址：

```bash
python -m pip install -r requirements-mobile.txt
python launch_mobile.py
```

也可以运行 `python launch.py --mobile`。手机启动器不会导入桌面 GUI 依赖，默认监听 `127.0.0.1:8000`，启动后会打印 `Open on this phone` 地址；如果环境里有 `termux-open-url`，会尝试自动打开浏览器。需要让同一局域网其它设备访问这台手机时，加 `--lan` 监听 `0.0.0.0`。

常用参数：

```bash
python launch_mobile.py --api-key "你的 DeepSeek API Key" --tavily-api-key "你的 Tavily API Key（可选）"
python launch_mobile.py --port 8010 --no-open
python launch_mobile.py --lan
```

### 方式 3：命令行启动（兼容旧用法）

```powershell
cd D:\deepseek
python -m pip install -r requirements.txt
$env:DEEPSEEK_API_KEY="你的 DeepSeek API Key"
$env:TAVILY_API_KEY="你的 Tavily API Key（可选，用于联网搜索）"
python app.py
```

macOS / Linux：

```bash
cd /path/to/deepseek
python -m pip install -r requirements.txt
export DEEPSEEK_API_KEY="你的 DeepSeek API Key"
export TAVILY_API_KEY="你的 Tavily API Key（可选，用于联网搜索）"
python app.py
```

也可以不设置环境变量，在页面右上角设置里临时填写 API Key。启动后终端会打印两个地址：`Computer`（电脑本机访问）和 `Phone`（手机访问，需与电脑在同一 Wi-Fi 或局域网）。

默认情况下所有 `/api/*` 请求都需要本地访问令牌，请使用终端打印的带 `?token=...` 的地址打开应用，浏览器会自动保存认证 Cookie；桌面本地应用窗口会自动用 `?token=...&desktop=1` 完成首屏认证。默认 token 会写入本地 `.auth-token` 并在重启后复用；如果页面提示「需要重新认证」，重新打开启动输出的 token 链接即可。

### 方式 4：打包成单个 exe 分发

需要把项目分发给完全没装 Python 的电脑时：

```powershell
python -m pip install -r requirements.txt
python -m pip install -r requirements-build.txt
python scripts/build_exe.py
```

会在 `dist/` 输出单个 `DeepSeekMobile.exe`（macOS / Linux 是 `DeepSeekMobile`）。双击默认打开本地应用窗口，不会跳外部浏览器；运行期间产生的 `.auth-token` / `.file-cache` / `.memory` 等数据会写到 exe 同目录，方便整目录一起搬家。旧启动器可通过 `DeepSeekMobile.exe --gui` 打开。

### 方式 5：打包成 Android APK

仓库内的 `android/` Android Studio 工程可把现有 Python 后端和 Web 前端打进 APK。APK 启动后会在应用私有目录运行 Python 服务，并用内置 WebView 打开 `127.0.0.1` 本机地址，手机上无需再安装 Termux 或 Pydroid。

```bash
cd android
gradle :app:assembleDebug
```

输出位置：`android/app/build/outputs/apk/debug/app-debug.apk`。详细环境、签名和安装说明见 [docs/APK.md](docs/APK.md)。

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API Key。可不填，改为在页面设置里临时输入。
- `TAVILY_API_KEY`：Tavily 搜索 API Key。可不填，改为在页面设置里临时输入或选择保存到本机浏览器。
- `PORT`：本地服务起始端口，默认 `8000`。
- `HOST=0.0.0.0`：开启局域网 / 手机访问；默认只监听 `127.0.0.1`。
- `AUTH_DISABLED=1`：关闭本地 token 鉴权，仅建议在可信开发环境使用。
- `AUTH_TOKEN=...`：使用固定 token，便于本地测试。
- `AUTH_ALLOWED_HOSTS=host1,host2`：追加允许的 Host 头名称。
- `OCR_ENABLED=1`：默认允许 OCR；未开启时也可在上传失败后点击 OCR 重试。
- `OCR_MODE=fast|balanced|quality`：本地 OCR 增强档位，默认 `balanced`；`quality` 会多跑候选图像和版面模式，速度更慢但对小字、倾斜截图更稳。
- `OCR_PDF_DPI=300`：扫描 PDF 渲染 DPI，限制在 `150..450`，默认 `300`。
- `OCR_MAX_IMAGE_PIXELS=16000000`：OCR 前允许处理的最大图片像素数，超出会等比缩小。
- `OCR_FORMULA_CMD='pix2tex "{image}"'`：可选的本地公式 OCR 命令，从 stdout 输出 LaTeX / 文本，`{image}` 会替换为临时图片路径；未设置时会自动尝试 PATH 中的 `pix2tex` / `latexocr`。
- `OCR_FORMULA_TIMEOUT_SECONDS=120`：公式 OCR 命令超时，限制在 `5..600` 秒。
- `DEEPSEEK_TIMEOUT_SECONDS`：DeepSeek 同步、流式和上下文压缩请求的 socket idle 超时，默认 `180`。
- `MULTI_AGENT_TIMEOUT_SECONDS`：多 Agent Coder / Reasoner 并行层级超时，默认 `3900`；长任务建议与 `DEEPSEEK_TIMEOUT_SECONDS` 一起调高。
- `MULTI_AGENT_TOKEN_BUDGET`：多 Agent 单次运行的 token 预算，默认 `2000000`，设 `0` 不限制。
- `TAVILY_TIMEOUT_SECONDS`：Tavily 搜索请求超时，默认 `45`。
- `UPLOAD_FILE_MAX_BYTES`：单文件上传上限，默认 `200000000`（约 200 MB）。
- `UPLOAD_MAX_BYTES`：单次 multipart 请求体总上限，默认 `220000000`。
- `EDGE_INFERENCE_ENABLED=1` / `EDGE_INFERENCE_PROVIDER` / `EDGE_MODEL_PATH`：可选的本地端侧推理开关、后端与 GGUF 模型路径，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 安装与依赖

`requirements.txt` 包含后端运行与文件解析所需的依赖，主要有：

- `openpyxl`：读取 `.xlsx`；`pypdf` / `PyMuPDF`：读取 PDF 文字与逐页渲染。
- `python-pptx`：生成 `.pptx`；`reportlab`：生成带内置中文字体的 PDF。
- `multipart`：流式解析 `multipart/form-data` 上传；`defusedxml`：安全解析 `.docx` / `.xlsx` 内部 XML。
- `customtkinter`：桌面 GUI 启动器依赖；手机本机运行改用 `requirements-mobile.txt`，无需安装这一项。
- `pywebview`：桌面端本地应用窗口依赖，用系统 WebView 显示本机界面。

> 注意：正式依赖是 `multipart>=1.3,<2`。如果环境里同时装了占用同名命名空间的 `python-multipart`，上传接口会返回明确的依赖错误；请按 `requirements.txt` 重新安装，避免两个包混用。

可选依赖按需安装：`requirements-ocr.txt`（本地 OCR）、`requirements-rag.txt`（`sqlite-vec` / ONNX 本地 embedding）、`requirements-edge.txt`（`llama-cpp-python` 端侧推理）、`requirements-build.txt`（PyInstaller 打包）。

图片 OCR 优先用 `DEEPSEEK_API_KEY` 调 DeepSeek API 转写；API Key 缺失或识别不可用时，桌面端才回退本地 Tesseract / Windows OCR。扫描 PDF 需要 Poppler / `pdftoppm` 在 `PATH` 中先把页面渲染成图片；Android APK 用 ML Kit 作为本机兜底。

## 本地数据与隐私

主要数据都保存在本机：

- 对话历史 / 未发送草稿 / 自定义 Seek：浏览器 `localStorage`。
- 项目空间 / 文档库：`.projects/{projectId}/`。
- 文件分块缓存：`.file-cache`；搜索缓存：`.search-cache`。
- 本地 RAG 向量索引：`.local-rag/rag.sqlite3`。
- 链路追踪：`.traces/traces.sqlite3`；语义缓存：`.semantic-cache/cache.sqlite3`。
- 网关请求队列：`.request-queue/queue.sqlite3`。
- 本地提醒队列：`.reminders/reminders.json`；长期记忆：`.memory/memories.json`。
- 可恢复 Agent Run：`.agent-runs/`。
- API Key：DeepSeek / Tavily Key 可选择保存在浏览器，也可以只用服务端环境变量。

文件分块缓存会自动清理：默认保留 14 天内缓存并把 `.file-cache` 总量控制在约 500 MB；`.projects/` 是持久文档库，只在删除项目时移除。服务启动时清理一次，运行期间约每 6 小时后台清理一次。

`.gitignore` 默认排除运行期缓存、长期记忆、项目文档库、本地 RAG / Trace / 语义缓存 / 请求队列、提醒队列、覆盖率、IDE 配置和本地 `server*.log`。发布压缩包或提交代码前，请不要把 `.file-cache`、`.projects`、`.local-rag`、`.traces`、`.semantic-cache`、`.request-queue`、`.memory`、`.reminders`、`.search-cache` 等本地数据打包进去。发布压缩包建议使用：

```powershell
python scripts/release.py --clean-workspace
```

脚本会生成 `dist/deepseek-mobile-<version>.zip`，并排除本地缓存、日志、虚拟环境和 IDE 文件。

## 文档

- [CHANGELOG.md](CHANGELOG.md) — 逐版本变更记录。
- [docs/API.md](docs/API.md) — HTTP API 与鉴权。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 整体架构、端云路由与本地数据层。
- [docs/FRONTEND_MODULES.md](docs/FRONTEND_MODULES.md) — 前端模块拆分。
- [docs/APK.md](docs/APK.md) — Android 打包、签名与安装。
- [docs/SECURITY.md](docs/SECURITY.md) — 鉴权、敏感数据与本地安全边界。

## 注意事项

手机浏览器可以直接使用 `http://局域网IP:端口`。如果要像正式 App 一样稳定安装到手机桌面，通常需要 HTTPS 部署；本地 HTTP 更适合开发和局域网试用。PWA 缓存清理由 `static/sw.js` 的 activate 阶段统一负责，页面脚本不再单独维护缓存版本号。
