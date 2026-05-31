# DeepSeek Mobile

![版本](https://img.shields.io/badge/version-1.6.6-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-green)
![许可证](https://img.shields.io/badge/license-MIT-black)

DeepSeek Mobile 是一个手机优先、本地优先的 AI 客户端。桌面端可打包成双击即用的本地应用窗口，手机端可打包成 APK；本机 Python 后端负责转发 DeepSeek API、搜索、文件解析、OCR、长期记忆、持久项目文档库、本地工具调用和静态资源。v1.6.6 把前端换上 Gemini 风格的新皮肤，并修复桌面 WebView 启动鉴权、选区引用提问、当前时间上下文、多 Agent 历史回放丢答案、Markdown 链接和饼图渲染等问题；v1.6.5 强化多 Agent 模式：新增 token 预算护栏、Critic 自动修订环和动态 DAG 编排；v1.6.3 起 Windows exe 默认入口为内嵌 WebView 的本地桌面应用，不再需要跳转外部浏览器。

## v1.6.6 更新

- 前端换上 Gemini 风格新皮肤：`static/gemini.css` 以 `body.gemini-ui` 作用域叠加在 `styles.css` 之后，统一蓝色主色、Google Sans 字体、Material 3 圆角与中性背景，欢迎语改为「你好，今天能帮你点什么？」，皮肤可整体开关、零 DOM 结构改动。
- 修复桌面本地应用窗口启动后显示 `Auth required`：pywebview 入口会在 token URL 上追加 `desktop=1`，服务端验证后直接返回首页并写入 HttpOnly Cookie，避免内嵌 WebView 在跳转中丢 Cookie。
- 修复“选中内容进行提问”在移动端和复杂选区中失效：选区识别改为命中单条聊天消息气泡即可引用，用户消息和助手消息都支持；触屏 `touchstart` 不再吞掉引用按钮点击。
- DeepSeek 请求会在本轮尾部 dynamic context 中附带当前本地时间和 UTC 时间，让模型回答“今天/明天/现在”等相对时间问题时有真实基准，同时不改写稳定 system prompt。
- 修复多 Agent 历史回放丢答案：Agent Run 流式重连后若仍处于 `created/planning/running`，客户端会带 `after=` 续连而不是提前结束，避免后台已 `done` 但前端落到空综合兜底、留下卡住的「运行中」转圈。
- 修复 Markdown 链接被二次转义导致 `&amp;` 类 URL 打不开；修复饼图单切片占满 100% 时退化弧线渲染成空白，改用整圆。
- 清理历史列表里 4 段永远走不到的死分支（编辑/删除/收藏/标签都已由菜单动作统一处理）。
- 发布脚本不再把 `.git/`、`.claude/` 打进 zip，并把 `.launcher-config.json` 纳入 `.gitignore`，避免本地密钥误入发布包。
- Service Worker 缓存版本更新到 `deepseek-mobile-v166`，并预缓存 `gemini.css`，新皮肤可离线生效。

## v1.6.5 更新

- 多 Agent token 预算护栏：新增 `MULTI_AGENT_TOKEN_BUDGET`（默认 2,000,000，设 `0` 不限制），累计超预算后不再启动后续 worker 层，但综合阶段始终执行，保证总能拿到最终答案。
- Critic 修订环：Critic 复核后可点名一个前序 worker（researcher / coder / reasoner）带着反馈重跑一次再综合（仅一轮）；实时 SSE 与历史回放都会把该 worker 卡片替换成修订后的结果。
- 动态 DAG 编排：Planner 计划里的 agent 可声明可选 `depends_on`，按依赖做拓扑分层、同层并行；未声明依赖的计划完全复刻原有 `researcher → (coder ∥ reasoner) → critic` 行为，零行为变化。
- Service Worker 缓存版本更新到 `deepseek-mobile-v165`。

## v1.6.3 更新

- Windows 桌面端 exe 默认打开本地应用窗口：后端在本机进程内启动，界面嵌入系统 WebView，不再弹浏览器标签页。
- 旧 GUI 启动器仍保留，可用 `DeepSeekMobile.exe --gui` 打开；内部服务模式仍用 `--server`。
- 打包脚本会收集 `pywebview` / `pythonnet` / `clr_loader` 依赖，确保单文件 exe 能运行本地应用壳。
- Service Worker 缓存版本更新到 `deepseek-mobile-v163`。

## v1.6.2 更新

- Android APK 内置 ML Kit 中文文本识别桥接，图片 OCR 和扫描 PDF OCR 不再依赖手机系统安装 Tesseract / Poppler。
- APK 启动时默认开启 `OCR_ENABLED=1`，前端点 OCR 重试或上传图片时会直接走手机本机识别。
- 桌面端仍保留原有 Tesseract / Poppler OCR 路线；Service Worker 缓存版本更新到 `deepseek-mobile-v162`。

## v1.6.1 更新

- 联网搜索工具 `web_search` 现在会复用 `.search-cache` 中的同查询结果，避免同一轮或相近请求反复拿到细微变化的搜索结果。
- 工具调用交换会把上游随机 `tool_call_id` 改成稳定 ID，并把工具参数 JSON 规范化，减少第二轮 DeepSeek 请求在工具调用处提前 cache miss。
- 传给模型的联网搜索工具结果会移除 `cached` 这类只服务本地状态的波动字段，并使用稳定 JSON 序列化；前端搜索进度和诊断仍保留搜索缓存状态。
- Service Worker 缓存版本更新到 `deepseek-mobile-v161`。

## v1.6.0 更新

- 新增手机本机启动器：`launch_mobile.py` / `launch_mobile.sh` 和 `python launch.py --mobile` 都会走无 Tk、无 `customtkinter` 的控制台启动流程，适合 Android Termux、Pydroid 终端和其它没有桌面 GUI 的 Python 环境。
- `launch.py` 会识别 `ANDROID_ROOT`、`TERMUX_VERSION`、`PYDROID_PACKAGE` 等移动端环境标记；在手机上直接运行 `python launch.py` 时自动进入手机模式，桌面端当前默认打开本地应用窗口，旧 GUI 启动器可用 `--gui` 打开。
- 新增 `requirements-mobile.txt`，只包含后端运行所需的纯 Python 依赖，避免手机安装桌面 GUI 依赖。
- 手机启动器默认监听 `127.0.0.1`，启动后打印带 token 的本机地址；Termux 安装了 `termux-open-url` 时会自动拉起浏览器，否则复制输出的地址到手机浏览器即可。
- Service Worker 缓存版本更新到 `deepseek-mobile-v160`。

## 历史亮点

v1.0.0 引入 4 种视觉风格 × 3 种明暗模式的主题系统；v1.1.5 增加搜索硬预算、历史搜索状态恢复、流式代码围栏保护和 Leader + 多 Agent 工作模式；v1.2.0 上线 Activity 侧栏；v1.3.0 开启 Agent 工作台体验；v1.4.0 新增可恢复 Agent Run；v1.5.0 新增桌面 GUI 启动器和单 exe 打包；v1.5.1 修复搜索 prompt cache 与前端面板交互。

## v1.5.1 更新

- 搜索开关不再改写首个 system message：搜索工具提示和搜索结果都追加到本轮尾部动态上下文，避免一开搜索就把前面整段历史的 DeepSeek prompt cache 打断。
- 修复 Activity 面板“复制 Agent 过程”重复触发的问题：按钮只走面板事件委托，不再同时绑定第二条点击逻辑。
- Escape 现在会关闭设置、Seek、项目、搜索结果、文件预览、记忆、诊断和 Activity 等可见面板，桌面侧栏模式下也不会卡住。
- 焦点陷阱改为栈式管理：确认框叠在其它面板上时，关闭后会恢复到底层面板的焦点循环，键盘操作更稳定。

## v1.5.0 更新

- 新增 GUI 启动器：运行 `python launch.py --gui` 或 `DeepSeekMobile.exe --gui` 可打开旧启动器窗口，填 API Key、勾选「允许局域网访问」、设端口后点「启动服务」即可。
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

### 方式 1（推荐）：本地桌面应用窗口

1. 安装一次 Python 依赖：
   ```powershell
   python -m pip install -r requirements.txt
   ```
2. **Windows** 直接双击 `launch.bat`，**macOS / Linux** 双击或执行 `./launch.sh`，会打开 DeepSeek Mobile 本地应用窗口。
3. 在应用右上角设置里填写 DeepSeek API Key（必填）和 Tavily API Key（可选）；也可以先通过环境变量提供 Key。

桌面应用会自动使用带 `desktop=1` 的本地 token 入口完成认证，双击后不需要手动复制 token 链接；如果用浏览器访问命令行服务，仍使用终端打印的 `?token=...` 地址。

旧 GUI 启动器仍保留：需要手动选择端口、局域网模式或查看服务日志时，运行 `python launch.py --gui` 或 `DeepSeekMobile.exe --gui`。

### 方式 2：手机本机直接运行

Android 手机上可以用 Termux 或 Pydroid 这类 Python 环境直接跑后端，然后在同一台手机浏览器里打开本机地址：

```bash
python -m pip install -r requirements-mobile.txt
python launch_mobile.py
```

也可以运行：

```bash
python launch.py --mobile
```

手机启动器不会导入桌面 GUI 依赖。它默认监听 `127.0.0.1:8000`，启动后会打印 `Open on this phone` 地址；如果环境里有 `termux-open-url`，会尝试自动打开浏览器。需要让同一局域网其它设备访问这台手机时，加 `--lan` 监听 `0.0.0.0`。

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

也可以不设置 `DEEPSEEK_API_KEY` 或 `TAVILY_API_KEY`，在页面右上角设置里临时填写 API Key。

启动后终端会打印两个地址：

- `Computer`：电脑本机访问地址。
- `Phone`：手机访问地址，手机需要和电脑在同一 Wi-Fi 或局域网。

默认情况下所有 `/api/*` 请求都需要本地访问令牌。请使用终端打印的带 `?token=...` 的地址打开应用，浏览器会自动保存认证 Cookie；桌面本地应用窗口会自动使用 `?token=...&desktop=1` 完成首屏认证。v1.4.0 起默认 token 会写入本地 `.auth-token` 并在重启后复用，避免服务重启后旧浏览器 Cookie 立刻失效；如果页面提示“需要重新认证”，重新打开启动输出的 token 链接即可。

### 方式 4：打包成单个 exe 分发

需要把项目分发给完全没装 Python 的电脑时：

```powershell
python -m pip install -r requirements.txt
python -m pip install -r requirements-build.txt
python scripts/build_exe.py
```

会在 `dist/` 输出单个 `DeepSeekMobile.exe`（macOS/Linux 是 `DeepSeekMobile`）。双击默认打开本地应用窗口，不会跳外部浏览器；运行期间产生的 `.auth-token` / `.file-cache` / `.memory` 等数据会写到 exe 同目录，方便整目录一起搬家。旧启动器可通过 `DeepSeekMobile.exe --gui` 打开。

### 方式 5：打包成 Android APK

仓库新增 `android/` Android Studio 工程，可把现有 Python 后端和 Web 前端打进 APK。APK 启动后会在应用私有目录运行 Python 服务，并用内置 WebView 打开 `127.0.0.1` 本机地址，手机上无需再安装 Termux 或 Pydroid。

```bash
cd android
gradle :app:assembleDebug
```

输出位置：`android/app/build/outputs/apk/debug/app-debug.apk`。详细环境、签名和安装说明见 `docs/APK.md`。

## 环境变量

- `DEEPSEEK_API_KEY`：DeepSeek API Key。可不填，改为在页面设置里临时输入。
- `TAVILY_API_KEY`：Tavily 搜索 API Key。可不填，改为在页面设置里临时输入或选择保存到本机浏览器。
- `PORT`：本地服务起始端口，默认 `8000`。
- `HOST=0.0.0.0`：开启局域网/手机访问；默认只监听 `127.0.0.1`。
- `AUTH_DISABLED=1`：关闭本地 token 鉴权，仅建议在可信开发环境使用。
- `AUTH_TOKEN=...`：使用固定 token，便于本地测试。
- `AUTH_ALLOWED_HOSTS=host1,host2`：追加允许的 Host 头名称。
- `OCR_ENABLED=1`：默认允许 OCR；未开启时也可在上传失败后点击 OCR 重试。
- `OCR_MODE=fast|balanced|quality`：本地 OCR 增强档位，默认 `balanced`；`quality` 会多跑候选图像和版面模式，速度更慢但对小字、倾斜截图更稳。
- `OCR_PDF_DPI=300`：扫描 PDF 渲染 DPI，限制在 `150..450`，默认 `300`。
- `OCR_MAX_IMAGE_PIXELS=16000000`：OCR 前允许处理的最大图片像素数，超出会等比缩小，降低内存占用。
- `OCR_FORMULA_CMD='pix2tex "{image}"'`：可选的本地公式 OCR 命令。命令从 stdout 输出 LaTeX/文本，`{image}` 会替换为临时图片路径；未设置时会自动尝试已在 PATH 中的 `pix2tex` 或 `latexocr`。
- `OCR_FORMULA_TIMEOUT_SECONDS=120`：公式 OCR 命令超时，限制在 `5..600` 秒。
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
- `customtkinter`：桌面 GUI 启动器依赖；手机本机运行可改用 `requirements-mobile.txt`，不需要安装这一项。
- `pywebview`：桌面端本地应用窗口依赖，用系统 WebView 显示本机界面，不跳外部浏览器。

注意：正式依赖是 `multipart>=1.3,<2`。如果环境里同时安装了会占用同名命名空间的 `python-multipart`，上传接口会返回明确的依赖错误；请按 `requirements.txt` 重新安装，避免两个包混用。

可选 OCR 依赖：

```powershell
python -m pip install -r requirements-ocr.txt
```

桌面端图片 OCR 会优先使用已安装的 Tesseract；如果 Tesseract / Python OCR 依赖不可用，或 Tesseract 在实际识别时失败，Windows 本地应用会自动尝试系统自带 `Windows.Media.Ocr` 作为兜底。桌面端扫描 PDF OCR 仍需要 Poppler / `pdftoppm` 在 `PATH` 中；Android APK 内置 ML Kit OCR 桥接，图片和扫描 PDF OCR 不需要额外安装 Tesseract / Poppler。

桌面 Tesseract 路线会按 `OCR_MODE` 生成本地轻量候选：灰度、小图放大、保边去噪、Otsu 二值化、深色背景反相；`balanced`/`quality` 还会尝试自适应阈值和弱光增强，`quality` 再做轻量倾斜校正。Tesseract 会按多个 `psm` 版面模式重试并用可读字符评分选择结果，其中包括更适合公式截图的单行/原始行模式和 `preserve_interword_spaces=1`；如果本机 Tesseract 安装了 `equ` 公式语言包，也会自动并入识别语言。

公式截图如果仍然很差，建议安装本地公式 OCR 工具并通过 `OCR_FORMULA_CMD` 接入，例如 `pix2tex "{image}"`。后端会把公式 OCR 输出的 LaTeX 与 Tesseract/Windows OCR 结果一起评分择优；命令输出可以是纯文本、Markdown 代码围栏或包含 `latex`/`text`/`result` 字段的 JSON。扫描 PDF 会逐页处理，某页 Tesseract 为空或失败时可继续用 Windows OCR 或公式命令兜底。OCR 文本会做基础结构整理，保留疑似表格列、键值对、数学符号行、上下标符号和换行。当前仍是本机“图片文字识别”，不会描述没有文字的画面，也不会把原始图片发给 DeepSeek 或云端服务。OCR 不可用时，上传会返回 `ocr_unavailable` 和安装提示。

## 功能

- 支持视觉风格和明暗模式切换：可在 ChatGPT、Linear、Notion、Arc 四种风格之间切换，并选择跟随系统、浅色或深色；设置会保存在浏览器本地，首屏渲染前自动应用，减少主题闪烁。
- v1.1.1 重新打磨四套视觉主题：ChatGPT 极简白、LinearFlow 深色专业、Notion 晨光暖色和 Arc 紫粉渐变玻璃各自有更鲜明的色阶、阴影、圆角和主题特定质感。
- v1.1.5 加强搜索稳定性：普通对话单轮搜索有硬上限，`compare_search_results` 最多执行 2 个 query，刷新或中断后残留的 `searching` 状态会自动收尾为错误，避免旧对话打不开或一直显示“正在搜索”。
- v1.1.5 新增多 Agent 模式：开启后由 Leader 拆解任务，Researcher / Coder / Reasoner / Critic 等 Agent 并行输出公开摘要，Leader 再综合成最终回答；Researcher 可联网搜索，1.4.0 起单轮 Agent Run 共享搜索预算为 12 次、单 Researcher 上限为 5 次。
- 支持多轮互补联网搜索：force/on 模式会预取原问题和互补查询；如果页面刷新、中断或断线留下未完成搜索轮，前端会自动收尾为明确的失败状态。
- 支持 Web Speech API 语音输入：浏览器支持时，输入框旁会显示麦克风按钮，可直接把口述内容写入当前草稿；设置面板可切换语音识别/朗读语言。
- 支持浏览器本地朗读：每段助手回复可点击“朗读这段”，由 `speechSynthesis` 在本机分句播放；朗读前会清理 LaTeX、引用 pin、表格分隔符和代码块，减少“反斜杠 frac”这类噪声。
- 支持选取聊天消息片段继续提问：在用户或助手消息中选中文字或公式后，输入区的“引用所选”按钮会亮起；点击后片段进入引用预览，下一轮提问会锚定到这段内容。公式会优先保留原始 LaTeX 源码。
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
- 支持首轮回复后自动生成对话标题；历史菜单可重命名、收藏、添加标签、全文搜索，也可重新生成标题。
- 支持选取用户或助手消息片段后直接“引用提问”，自动把所选片段带入下一条用户消息。
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
