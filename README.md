# DeepSeek Mobile

![版本](https://img.shields.io/badge/version-1.5.0-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-green)
![许可证](https://img.shields.io/badge/license-MIT-black)

DeepSeek Mobile 是一个手机优先的本地 Web 聊天客户端。电脑运行轻量 Python 后端，负责转发 DeepSeek API、搜索、文件解析、OCR、长期记忆、持久项目文档库、本地工具调用和静态资源；手机和电脑在同一 Wi-Fi 或局域网内即可用浏览器访问。v1.0.0 引入 4 种视觉风格 × 3 种明暗模式的主题系统；v1.0.1 恢复 force/on 搜索模式下的多轮互补预取，并修复搜索完成或中断后仍显示“正在搜索”的状态污染；v1.1.1 重新校准 ChatGPT、Linear、Notion、Arc 四套视觉主题；v1.1.5 增加搜索硬预算、历史搜索状态恢复、流式代码围栏保护和 Leader + 多 Agent 工作模式；v1.1.6 修复多 Agent 模式下 `ThreadPoolExecutor` 在 worker 超时时仍会阻塞主请求的问题，并补齐 `default_agent_plan` 的 `coder` 兜底；v1.1.7 移除助手消息气泡的边框，让回复内容在 Linear / Arc 主题下也呈现无框纯文本布局；v1.1.8 多 Agent 改为只允许 Researcher 联网搜索、加 `python_eval` 默认超时到 8 秒、给 Agent 摘要加 6000 字截断、Leader 汇总时保留原始对话上下文，体验更稳；v1.1.9 polish：Leader 综合阶段恢复 prompt injection 安全提醒、非 Researcher 系统提示词改为"不要联网搜索；如发现缺少外部事实请交给 Researcher 核查"、Researcher 摘要末尾自动附最多 5 个搜索来源 URL；v1.2.0 上线 Activity 侧栏（桌面端把思考/搜索/Agent 过程移到右侧常驻面板，移动端保留底部弹层），切换会话时清理旧面板和状态，工具调用上限改为软降级，多 Agent 模式 Researcher 才能联网，整体动效再打磨；v1.2.1 桌面端 history-panel 升级为常驻左侧 sidebar，左右双 sidebar 同时打开时正文在中间对称居中；空对话页换上欢迎语 + 4 张 suggestion cards；修复 Activity 侧栏内长内容溢出；v1.2.2 多 Agent 改为 DAG 分层执行（Researcher → Coder/Reasoner 并行 → Critic），后续层能引用前面层的摘要；Leader 综合阶段改流式输出；单 Agent 失败自动重试 1 次；v1.2.3 修复多 Agent 长任务里 Leader 综合阶段频繁丢内容——彻底取消单 Agent 摘要和总预算两层硬截断，worker 区输出多长 Leader 综合就拿到多长，完全所见即所得；同时修复思考计时器在多 Agent 模式下被首个 content 事件提前停掉的 bug，reasoning 重新到达时恢复计时；v1.2.4 大改多 Agent 事件流：Planner 的 JSON 不再写主聊天区（修"黑框" bug），worker content 改走 `agent_delta` 进 Activity 卡片（主正文只装 Synthesizer 最终答案），worker 输出强制 `## 摘要 / 事实 / 风险 / 完整分析` 四段结构（Leader 综合只吃前三段，full_output 留 Activity），search 事件按 phase 隔离避免 round 1 互相覆盖；Agent 工具权限按角色收窄：researcher 联网、coder 本地代码工具不联网、reasoner/critic 纯推理无工具。v1.2.5 把 Coder / Reasoner 中间层改成真并行，worker 的 reasoning 改走 `agent_reasoning` 留在各自 Agent 卡片，工具调用 `system_note` 也会显示在对应卡片内，并给失败 Agent 补充可综合的降级摘要和风险提示。v1.2.6 增加 Agent 展示模式（简洁/详细）、已完成 Agent 卡片默认折叠、稳定 Agent step id、独立 `agent_note` 工具状态事件，并把 request-level cancel token 传到流式、多 Agent 和工具调度层。v1.2.7 修一个 1.2.6 残留 P0：Leader 在一次会话内会被 emit 两轮（任务拆解 + 最终综合），原 `agentStepId(phase)` 只按 phase 生成 id 让两张 Leader 卡片塌成同一个 DOM key、第二张盖掉第一张；新版改 `createAgentStepId(message, phase)` 按 timeline 内同 phase 计数生成 `agent-{phase}-{N}`，`normalizeTimeline` 也会给旧 history 重复 id 补号去重。顺带把 agent timeline 的 12 个纯函数抽到独立模块 `static/modules/agent_timeline.js`，可以脱 DOM 单测；折叠策略升级为分级：Leader 完成后保留展开、错误 Agent 默认展开、其他完成 worker（researcher/coder/reasoner/critic）默认折叠；并补两条 cancel 工具层测试（`execute_tool_calls` 在 cancel 已 set 时不执行真实工具；并行 middle tier cancel 后不再 emit `agent_delta`）。v1.2.8 把多 Agent 模式做成产品体验：Activity 顶部加一条执行摘要条（"3 Agents · 资料 ✓ · 代码 ✕ · 推理 ✓"），用户不用展开卡片就能看到整体状态；每张 Agent 卡片右上角显示耗时（"已完成 · 1.3s" / "失败 · 2.5s"），后端在 done/error 事件携带 `durationMs`、串行/并行/超时各分支都计时；Synthesizer 收到含 failed Agent 的输入时，在最终回答里轻轻提示用户该角色缺席、保守作答，正常路径不带这段；`execute_tool_calls` 的 cancel 语义统一：并行 batch 启动后中途 cancel，未完成 slot 的错误体从 "Tool did not run" 改为 "Request cancelled before tool execution completed"。v1.2.9 修复历史恢复时 `durationMs: null` 被误还原为 `0ms` 的小坑，摘要条文案改为 "N 个 Agent"，失败 Agent chip 增加轻量边框和背景。v1.3.0 开启 Agent 工作台体验：Activity 面板和回复菜单支持复制 Agent 执行报告，`done.diagnostics.agentDurations` 输出 worker 耗时表，并修正多 Agent 分层执行的过期注释。

## v1.5.0 更新

- 新增 GUI 启动器：双击 `launch.bat`（Windows）或 `launch.sh`（macOS/Linux）打开窗口，填 API Key、勾选「允许局域网访问」、设端口后点「启动服务」即可，不再需要任何命令行操作。
- API Key 通过本机指纹（MAC + 路径 + 平台）派生密钥加密后保存到 `.launcher-config.json`，配合 HMAC 防篡改；同一份文件复制到别的电脑无法解密。
- 启动器支持启动 / 停止 / 重启服务、一键复制电脑或手机访问地址、内嵌服务日志窗口；关闭窗口前会先优雅停止后端进程。
- 新增 `scripts/build_exe.py`：`python scripts/build_exe.py` 调 PyInstaller 把整个项目（含 `static/` 与 KaTeX 字体）打包成单个 `dist/DeepSeekMobile.exe`，分发给没装 Python 的电脑也能双击直接用。
- `deepseek_mobile.core.config` 改为 PyInstaller 友好：冻结包运行时 `static/` 走 `_MEIPASS`，而 `.auth-token` / `.file-cache` / `.memory` / `.projects` / `.reminders` / `.agent-runs` / `.search-cache` / `.launcher-config.json` 仍写到 exe 同目录，重启数据不丢。
- `deepseek_mobile.app` 重构出 `prepare_and_start(host, port, serve=...)` 与 `shutdown_handle(handle)` 程序化接口，CLI 行为完全兼容；启动器走子进程方式调用，可以中途改 Key/端口后重启服务。

## v1.4.0 更新

- 新增 `.agent-runs/` 持久化 Agent Run，事件日志带 `runId` / `index` / `createdAt`，刷新页面或断线后可从最后事件继续恢复。
- 多 Agent 前端改为先创建 Agent Run 再 attach stream；`events` 是恢复 UI 的唯一事实源，`finalAnswer`、`agentOutputs`、`diagnostics` 只是快速读取快照。
- Auto Agent 或手动开启计划确认时会进入可编辑计划工作台，普通完整 Agent 仍默认直接执行。
- Activity 卡片支持单 Agent 重跑，最终回答支持只重新综合；单 Agent 重跑不会自动级联其它 Agent，前端会明确提示。
- 服务启动时会把遗留 `created` / `planning` / `running` run 标记为 `orphaned`，避免重启后误显示仍在执行。
- Windows 下 Agent Run 写入改为唯一临时文件并重试原子替换，避免高频事件持久化时偶发 `WinError 5`；Service Worker 缓存随热修更新，确保 Activity 展开逻辑刷新到浏览器。

## v1.3.9 更新

- 诊断面板里的 Agent cache 标签统一中文化。
- 各 Agent cache 明细从一长串文本改成多行展示，更容易比较资料 / 代码 / 推理 / 审查 / 综合的命中情况。
- 只调整前端展示层，不改多 Agent prompt、编排或 cache 统计口径。

## 快速开始

### 方式 1（推荐）：双击启动 GUI

1. 安装一次 Python 依赖：
   ```powershell
   python -m pip install -r requirements.txt
   ```
2. **Windows** 直接双击 `launch.bat`，**macOS / Linux** 双击或执行 `./launch.sh`，会弹出启动器窗口。
3. 在窗口里填写 DeepSeek API Key（必填）和 Tavily API Key（可选），按需勾选「允许手机/同局域网访问」，点「启动服务」即可。「打开浏览器」按钮会自动带上访问令牌打开页面。
4. Key 会用本机指纹加密保存到 `.launcher-config.json`，下次双击启动时自动填上，不需要再输入。

启动器内嵌服务日志窗口，关闭窗口前会先优雅停止后端进程；中途想换 Key 或端口，直接「停止服务」→ 修改 → 「启动服务」即可，不用重启窗口。

### 方式 2：命令行启动（兼容旧用法）

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

也可以不设置 `DEEPSEEK_API_KEY` 或 `TAVILY_API_KEY`，在页面右上角设置里临时填写 API Key。

启动后终端会打印两个地址：

- `Computer`：电脑本机访问地址。
- `Phone`：手机访问地址，手机需要和电脑在同一 Wi-Fi 或局域网。

默认情况下所有 `/api/*` 请求都需要本地访问令牌。请使用终端打印的带 `?token=...` 的地址打开应用，浏览器会自动保存认证 Cookie。v1.4.0 起默认 token 会写入本地 `.auth-token` 并在重启后复用，避免服务重启后旧浏览器 Cookie 立刻失效；如果页面提示“需要重新认证”，重新打开启动输出的 token 链接即可。

### 方式 3：打包成单个 exe 分发

需要把项目分发给完全没装 Python 的电脑时：

```powershell
python -m pip install -r requirements.txt
python -m pip install -r requirements-build.txt
python scripts/build_exe.py
```

会在 `dist/` 输出单个 `DeepSeekMobile.exe`（macOS/Linux 是 `DeepSeekMobile`）。双击即可开启 GUI；运行期间产生的 `.auth-token` / `.file-cache` / `.memory` 等数据会写到 exe 同目录，方便整目录一起搬家。

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API Key。可不填，改为在页面设置里临时输入。
- `TAVILY_API_KEY`：Tavily 搜索 API Key。可不填，改为在页面设置里临时输入或选择保存到本机浏览器。
- `PORT`：本地服务起始端口，默认 `8000`。
- `HOST=0.0.0.0`：开启局域网/手机访问；默认只监听 `127.0.0.1`。
- `AUTH_DISABLED=1`：关闭本地 token 鉴权，仅建议在可信开发环境使用。
- `AUTH_TOKEN=...`：使用固定 token，便于本地测试。
- `AUTH_ALLOWED_HOSTS=host1,host2`：追加允许的 Host 头名称。
- `OCR_ENABLED=1`：默认允许 OCR；未开启时也可在上传失败后点击 OCR 重试。
- `DEEPSEEK_TIMEOUT_SECONDS`：DeepSeek 同步、流式和上下文压缩请求的 socket idle 超时，默认 `180`。
- `MULTI_AGENT_TIMEOUT_SECONDS`：多 Agent Coder / Reasoner 并行层级超时，默认 `3900`；长任务建议与 `DEEPSEEK_TIMEOUT_SECONDS` 一起调高。
- `TAVILY_TIMEOUT_SECONDS`：Tavily 搜索请求超时，默认 `45`。
- `UPLOAD_FILE_MAX_BYTES`：单文件上传上限，默认 `200000000`（约 200 MB）。
- `UPLOAD_MAX_BYTES`：单次 multipart 请求体总上限，默认 `220000000`，用于容纳 200 MB 文件和表单边界开销。

## Python 依赖

`requirements.txt` 中的依赖用于增强文件读取和上传解析能力：

- `openpyxl`：读取 `.xlsx` 文件。
- `pypdf`：读取含可复制文字的 `.pdf` 文件。
- `multipart`：流式解析 `multipart/form-data` 上传，避免大文件整包进内存。
- `defusedxml`：安全解析 `.docx` / `.xlsx` 内部 XML，拦截实体放大类输入。

注意：正式依赖是 `multipart>=1.3,<2`。如果环境里同时安装了会占用同名命名空间的 `python-multipart`，上传接口会返回明确的依赖错误；请按 `requirements.txt` 重新安装，避免两个包混用。

可选 OCR 依赖：

```powershell
python -m pip install -r requirements-ocr.txt
```

OCR 还需要系统中安装 Tesseract。扫描 PDF OCR 还需要 Poppler / `pdftoppm` 在 `PATH` 中；图片 OCR 不需要 Poppler。OCR 不可用时，上传会返回 `ocr_unavailable` 和安装提示。

## 功能

- 支持视觉风格和明暗模式切换：可在 ChatGPT、Linear、Notion、Arc 四种风格之间切换，并选择跟随系统、浅色或深色；设置会保存在浏览器本地，首屏渲染前自动应用，减少主题闪烁。
- v1.1.1 重新打磨四套视觉主题：ChatGPT 极简白、LinearFlow 深色专业、Notion 晨光暖色和 Arc 紫粉渐变玻璃各自有更鲜明的色阶、阴影、圆角和主题特定质感。
- v1.1.5 加强搜索稳定性：普通对话单轮搜索有硬上限，`compare_search_results` 最多执行 2 个 query，刷新或中断后残留的 `searching` 状态会自动收尾为错误，避免旧对话打不开或一直显示“正在搜索”。
- v1.1.5 新增多 Agent 模式：开启后由 Leader 拆解任务，Researcher / Coder / Reasoner / Critic 等 Agent 并行输出公开摘要，Leader 再综合成最终回答；Researcher 可联网搜索，1.4.0 起单轮 Agent Run 共享搜索预算为 12 次、单 Researcher 上限为 5 次。
- 支持多轮互补联网搜索：force/on 模式会预取原问题和互补查询；如果页面刷新、中断或断线留下未完成搜索轮，前端会自动收尾为明确的失败状态。
- 支持 Web Speech API 语音输入：浏览器支持时，输入框旁会显示麦克风按钮，可直接把口述内容写入当前草稿；设置面板可切换语音识别/朗读语言。
- 支持浏览器本地朗读：每段助手回复可点击“朗读这段”，由 `speechSynthesis` 在本机分句播放；朗读前会清理 LaTeX、引用 pin、表格分隔符和代码块，减少“反斜杠 frac”这类噪声。
- 支持选取助手回复片段继续提问：在助手消息中选中文字或公式后，输入区的“引用所选”按钮会亮起；点击后片段进入引用预览，下一轮提问会锚定到这段内容。公式会优先保留原始 LaTeX 源码。
- 支持移动端动效反馈：按钮按下会有短促缩放，面板和遮罩平滑进出，新消息、Toast 和记忆建议会淡入；流式输出合并到 `requestAnimationFrame`，减少高频 token 到达时的抖动。
- 支持更完整的输入附件交互：可拖拽文件到页面、在输入框粘贴截图或文件；图片附件在本地生成缩略图，发送后的用户消息可点击图片进入 lightbox 预览。
- 支持应用内确认弹窗、带操作按钮的 Toast、专用无障碍 live region、面板焦点陷阱和 `?` 快捷键速查面板，减少系统弹窗和键盘焦点跑到背后的问题。
- 支持 PWA Share Target：安装到手机桌面后，可从系统分享菜单把文章标题、URL、文本、图片或文档分享给 DeepSeek Mobile；分享 POST 只做 Host 白名单校验，进入页面后仍需已鉴权会话读取并确认导入草稿。
- 支持完整 PWA 图标链路：manifest 提供 SVG、192/512 PNG 和 maskable 图标，浏览器标签页使用 favicon，iOS 使用 apple touch icon，提醒通知使用专用 icon/badge。
- 支持 `deepseek-v4-pro` 和 `deepseek-v4-flash`，默认使用 `deepseek-v4-pro`。
- 支持快速模式 / 专家模式切换；专家模式默认开启深度思考。
- 推理过程和最终回复均支持流式输出。
- 支持暂停输出、中断生成、继续生成、重新生成。
- 支持全局快捷键：`Ctrl/Cmd+K` 打开命令面板，`Ctrl+Enter` 发送，`Esc` 中断生成，输入框为空时按 `↑` 编辑上一条用户消息。
- 支持浅色、深色和跟随系统主题，并可调整回答阅读字号和代码块字号。
- 后端不可用时会进入离线模式，可继续查看和搜索本地历史，但不能发送新消息。
- 支持修改用户消息后重新生成回答。
- 支持从任意助手回复创建分支，保留旧走向并在新分支继续探索。
- 支持未发送草稿自动保存；刷新或意外离开后可恢复文本、附件和引用。
- 支持“明早 9 点提醒我...”这类本地提醒，后端保存任务，浏览器通过 Web Notification 到点提示。
- 支持历史对话标签、收藏和全文搜索。
- 支持选取助手回复片段后直接“引用提问”，自动把所选片段带入下一条用户消息。
- 支持项目空间 / 文档库：每个项目可以长期保存一组参考文档，进入项目对话后会自动参与附件检索，不受临时 `.file-cache` 清理策略影响。
- 支持回答引用回链：模型使用 `[^F1-2]` 这类引用标记时，前端会渲染为可点击 pin，并打开对应文件片段预览。
- 支持 DeepSeek function calling：模型可调用本地 `python_eval`、`search_files`、`fetch_url`、`web_search`、`suggest_memory`、提醒、记忆、项目文件、数据转换、图表和多查询对比工具，完成小型数学计算、跨临时附件/项目文档搜索、模型驱动联网搜索、搜索结果来源二次精读、Markdown 图表表格生成，以及受用户确认或作用域限制控制的本地记忆/提醒操作。
- 支持关闭 / 自动 / 强制三档联网搜索；自动模式由模型决定本轮是否联网，Tavily Key 可来自服务端环境变量，也可来自页面设置中的本轮请求。
- 支持 Seek 助手：创建本地自定义助手，保存名称、简介、专属指令、开场提示和参考文件，并在对话中自动注入对应系统指令。
- Seek 助手参考文件会随消息快照保存；继续生成、重新生成、编辑后重发和导出 Markdown 时都会使用消息当时的 Seek 和参考资料，而不是当前面板里选中的 Seek。
- 输入区会持续显示当前激活的 Seek 助手，可一键停用；点开场提示会自动进入新对话，避免把不同助手混在同一段上下文里。
- 自定义 Seek 最多保存 40 个，名称不可重复；名称和说明按 Unicode 字符截断，不会切坏 emoji。
- 支持导入/导出自定义 Seek JSON；导入时会自动跳过无效项、处理重名和 ID 冲突。
- 推荐 Seek 可一键复制为自定义 Seek 后继续编辑；历史列表会显示每段对话使用的 Seek 名称。
- 支持多轮搜索词生成、搜索结果去重重排、本地搜索缓存和搜索结果面板。
- 支持 Markdown 渲染：标题、列表、引用、表格、链接、粗体、斜体、行内代码、代码块、行内公式和独立公式；公式由本地 KaTeX 渲染，不依赖外部 CDN，流式生成中的未闭合块级公式会先按原文展示。
- 代码块支持行号、超长代码折叠、复制、下载和检测到本地路径时通过 `vscode://file/...` 打开；公式块可复制 LaTeX 源码，`mermaid` 代码块可用内置轻量 flowchart SVG 渲染。
- Markdown 表格中的数值列可一键渲染为柱状图、折线图或饼图，便于快速查看模型整理出的数据。
- 支持本地保存多轮对话、历史对话管理、右侧对话定位和导出 Markdown。
- 支持 PWA manifest、图标资源和 service worker，可在手机浏览器中安装到桌面。
- 支持图片 OCR 识图：PNG、JPG、WebP、BMP、TIFF、GIF 等图片可通过 OCR 提取文字，再作为附件片段参与回答。

## 文件读取

- 支持多文件上传，前端会展示上传进度、识别状态和错误信息。
- 上传接口使用流式 multipart 解析；默认单文件最大 200 MB、单次请求体最大 220 MB，前端会在选择、拖拽、粘贴和项目文档上传前先做预检。
- 支持文件预览，可查看后端实际抽取到的文本片段。
- 支持文本、Markdown、CSV、JSON、代码文件、RTF、HTML、DOCX、XLSX、PPTX、EPUB、PDF、PNG、JPG、WebP、BMP、TIFF、GIF 等格式。
- 文件会在本地后端解析并分块缓存，聊天请求只发送 `fileId` 等元数据。
- 提问时后端会按问题从缓存中检索相关片段，而不是把整份文件硬塞给模型；v0.7.1 起检索会结合关键词分数和本地哈希向量相似度，先提供完全本地的轻量语义排序。v0.7.2 起模型也可通过 `search_files` 工具主动检索 `.file-cache` 和 `.projects`。
- PDF 优先读取可复制文字；扫描版或图片型 PDF、照片和截图可通过 OCR 重试读取文字。
- 当前图片识别走 OCR 路线，只提取图片里的文字；它不是通用视觉模型，不能可靠描述没有文字的画面内容。

## 上下文与记忆

- 支持上下文压缩：旧摘要会与新增历史增量合并，最近消息保留原文。
- 后端在未提供摘要且消息超过硬上限时返回 `context_compression_required`，不会静默滑窗丢历史。
- 附件仍使用分块检索，不会被简单截断。
- 支持长期记忆：用户可以通过“记住：...”保存偏好、项目背景、长期任务等信息。
- 支持记忆建议：模型可在回答过程中提出值得长期保存的偏好或项目事实，前端会弹出确认提示，不会自动写入。
- 长期记忆支持 `global`、`project:<id>` 和 `seek:<id>` 作用域；项目或 Seek 对话只会检索全局记忆和当前上下文相关记忆。
- 保存新记忆时会做轻量冲突检测，例如“我喜欢 Vue”与“我换用 React 了”，用户确认后可替换旧记忆。
- 支持“忘记 ...”删除相关长期记忆。
- 设置里可以开启 / 关闭长期记忆、查看记忆、删除单条或清空全部。
- 长期记忆保存在本地 `.memory/memories.json`。
- API Key、token、密码、身份证、银行卡等敏感内容会被拦截，不保存到长期记忆。

## 本地数据

主要数据都保存在本机：

- 对话历史：浏览器 `localStorage`。
- 未发送草稿：浏览器 `localStorage`。
- 自定义 Seek：浏览器 `localStorage`。
- 项目空间 / 文档库：`.projects/{projectId}/project.json` 和 `.projects/{projectId}/files/`。
- 文件分块缓存：`.file-cache`。
- 搜索缓存：`.search-cache`。
- 本地提醒队列：`.reminders/reminders.json`。
- 长期记忆：`.memory/memories.json`。
- API Key：DeepSeek / Tavily Key 可选择保存在浏览器，也可以只使用服务端环境变量。
- PWA 分享缓存：系统分享进入 `/share-target` 后，后端会短暂保存分享草稿并生成一次性 `share` id；前端读取 `/api/share-target` 后即删除，默认约 30 分钟过期。

文件分块缓存会自动清理：默认保留 14 天内缓存，并把 `.file-cache` 总量控制在约 500 MB 内。项目空间里的 `.projects/` 是持久文档库，不参与临时附件缓存清理；删除项目时才会移除对应文档。搜索缓存会按过期时间清理。服务启动时会立即清理一次，并在运行期间约每 6 小时后台清理一次。

`.gitignore` 默认排除了运行期缓存、长期记忆、项目文档库、提醒队列、覆盖率、测试缓存、IDE 配置和本地 `server*.log`。发布压缩包或提交代码前，请不要把 `.file-cache`、`.projects`、`.memory`、`.reminders`、`.search-cache` 等本地数据打包进去。

发布压缩包建议使用：

```powershell
python scripts/release.py --clean-workspace
```

脚本会生成 `dist/deepseek-mobile-<version>.zip`，并排除本地缓存、日志、虚拟环境和 IDE 文件。

## 注意事项

手机浏览器可以直接使用 `http://局域网IP:端口`。如果要像正式 App 一样稳定安装到手机桌面，通常需要 HTTPS 部署；本地 HTTP 更适合开发和局域网试用。PWA 缓存清理由 `static/sw.js` 的 activate 阶段统一负责，页面脚本不再单独维护缓存版本号。


