## 概要

本会话目标：继续 1:1 复刻豆包的「阅读文档」体验。豆包式文档阅读工作台的前后端在工作区里已大量写好但未提交，本会话把它**修通、浏览器实测、补齐文档与回归测试**，并将整批未提交的 1.7.0 工作一并提交（见下方「范围说明」）。

## 本会话的核心改动（豆包文档阅读器）

**修复两个使阅读器不可用的真实 bug（均已在浏览器用 6 页 PDF 实测）：**

1. **上传 PDF 后阅读栏只渲染 1 页** —— `static/modules/chat.js` 的 `normalizeAttachment`（上传响应→附件）漏拷 `pageCount`，导致多页 PDF 退化成 1 页。补 1 行后实测 “1 / 6” + 6 页 + 6 缩略图。
2. **桌面常驻历史侧栏把阅读工作台挤成 ~84px** —— `body.history-side-open .chat` 与 `body.file-reader-side-open .chat` 同时设 `padding-left`，叠加后压垮工作台。`static/styles.css` 补 takeover 规则：阅读侧栏打开时历史栏让位（对齐既有 `official-rail` 的同款隐藏意图），关闭后状态不变、自动恢复。实测工作台恢复 452px。

**回归保护：** `tests/test_frontend_utils.py` 新增断言——附件归一化必须保留 `pageCount` / `sourceAvailable`（阅读器开图路径 `openFilePreview → normalizeStoredAttachment` 也走它）。

**文档：** `docs/API.md`（新增「文档原样阅读」整组只读接口 + `/api/file-text` 的 `pageCount`/`sourceAvailable` 字段）、`docs/ARCHITECTURE.md`（`files.py` 职责 + 「文档阅读工作台」章节）、`CHANGELOG.md`（1.7.0 条目）。

## 已验证

- 后端只读接口全部正常：`/api/file-source`、`/api/file-page-image`（PyMuPDF→pdf2image 兜底）、`/api/file-page-layout`（77 词框）、`/api/file-page-search`（跨 6 页命中）、`/api/file-page-text`、`/api/file-reader`。
- 前端分栏布局、翻页/页码跳转/缩放/缩略图、可选文字层（73 个定位词 span）、选中浮窗「解释/翻译/复制/问问 DeepSeek」、翻译全文、截图框选、一键总结 全部接线正确。
- 全量 `pytest` 套件通过。

## 范围说明（reviewer 请注意）

本 PR 同时携带了工作区里**既有的、未提交的 1.7.0 批次**（非本会话编写）：图片视觉理解（多模态）、`create_pptx`、`create_document`、`create_mindmap`、OCR 增强、搜索上限放宽等。原因：阅读器改动与这些 WIP 共用 `chat.js` / `styles.css` / `files.py` / `server.py`，**无法在文件级干净拆分**；经维护者确认，整批一起提交。详见 `CHANGELOG.md [1.7.0]`。

## 一个待定的产品决策

豆包是「打开文档即自动生成摘要」；当前实现是显示文档预览 + 「详细总结这篇文档内容」按钮（点击才发请求）。未擅自改成自动调用（会自动消耗 token）。如需「开图即自动总结」可在后续 PR 接 `openFilePreview` 触发。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
