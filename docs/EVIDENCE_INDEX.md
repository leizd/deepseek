# Release Evidence Index

适用版本：v2.3.4。

本页汇总 DeepSeek Infra v2.3.x 以来的互操作证据、评测报告与 release artifact，作为证据链的统一入口。所有标 ✅ 的项都可在无 GUI、无 API key 的干净环境中复现；标 🟡 的项需要人工 GUI 或真实第三方生态实测。

## Evidence Matrix

| Evidence | File | Status | Reproduce |
| --- | --- | --- | --- |
| MCP official SDK interop | [docs/integrations/external-mcp-server.md](integrations/external-mcp-server.md) | ✅ Tested | `python scripts/smoke_mcp_compat.py --external-server-url <url>` |
| Headless MCP bridge | [docs/evidence/headless-mcp-bridge.json](evidence/headless-mcp-bridge.json) | ✅ Tested | `python scripts/smoke_mcp_headless_bridge.py --out docs/evidence/headless-mcp-bridge.json` |
| A2A external peer | [docs/evidence/a2a-external-peer.json](evidence/a2a-external-peer.json) | ✅ Tested | `python scripts/smoke_a2a_external_peer.py --out docs/evidence/a2a-external-peer.json` |
| Claude Desktop GUI | [docs/integrations/claude-desktop.md](integrations/claude-desktop.md) | 🟡 Config documented + smoke entry ready | 人工按 runbook 完成 GUI 验证后更新 [docs/COMPATIBILITY.md](COMPATIBILITY.md) |
| Cursor GUI | [docs/integrations/cursor.md](integrations/cursor.md) | 🟡 Config documented + smoke entry ready | 人工按 runbook 完成 GUI 验证后更新 [docs/COMPATIBILITY.md](COMPATIBILITY.md) |
| Third-party A2A ecosystem | [docs/integrations/a2a-third-party-plan.md](integrations/a2a-third-party-plan.md) | 🟡 Adapter path documented | 待 LangGraph / CrewAI 等真实第三方 A2A peer 实测 |

## Eval Reports

| Report | File | Status |
| --- | --- | --- |
| Offline eval suite | [evals/reports/latest.json](../evals/reports/latest.json) / [latest.md](../evals/reports/latest.md) | PASS |
| Agent eval | [evals/reports/agent-latest.json](../evals/reports/agent-latest.json) / [agent-latest.md](../evals/reports/agent-latest.md) | PASS |

## Release Artifacts

每次发布生成以下 evidence artifact：

| Artifact | Example | Purpose |
| --- | --- | --- |
| Release zip | `dist/deepseek-infra-2.3.4.zip` | 可分发源码包 |
| Checksum | `dist/deepseek-infra-2.3.4.zip.sha256` | 校验 zip 完整性 |
| Manifest | `dist/deepseek-infra-2.3.4.manifest.json` | 版本、commit、构建环境、evidence 清单 |

构建命令：

```bash
python scripts/release.py --clean-workspace --version 2.3.4
```

## Preflight Checks

发版前必须通过的 preflight 检查：

```bash
python scripts/preflight_release.py --version 2.3.4
```

关键检查项：

- `docs_encoding_sanity`：文档无 `???`、`锟斤拷`、\ufffd 等乱码。
- `headless_mcp_bridge_evidence`：`docs/evidence/headless-mcp-bridge.json` 存在、版本匹配、关键步骤 PASS。
- `a2a_external_peer_evidence`：`docs/evidence/a2a-external-peer.json` 存在、版本匹配、关键 checks PASS。
- `gui_interop_evidence`：Claude Desktop / Cursor 为 WARNING，不阻断无 GUI 发版。
- `a2a_third_party_evidence`：Third-party A2A ecosystem 为 WARNING，待真实实测。

## Refresh Before Release

在干净的 CI / 本地环境依次复现：

```bash
python scripts/smoke_mcp_headless_bridge.py --out docs/evidence/headless-mcp-bridge.json
python scripts/smoke_a2a_external_peer.py --out docs/evidence/a2a-external-peer.json
python evals/runners/run_offline_eval_suite.py
python evals/runners/run_agent_eval.py
python scripts/preflight_release.py --version 2.3.4
```
