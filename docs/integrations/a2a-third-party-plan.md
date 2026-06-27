# A2A Third-Party Ecosystem — Verification Plan

适用版本：DeepSeek Infra v2.3.2。

本页说明 DeepSeek Infra 验证真实第三方生态 A2A 实现的下一步计划。v2.3.0 已完成独立进程 A2A peer 互操作验证（见 [a2a-interop.md](a2a-interop.md)），但那不是第三方生态实现。兼容矩阵中 "Third-party A2A implementation" 仍标为 🟡，本页记录验证路径，不强行标 ✅。

## 当前状态

| 验证层 | 状态 | 证据 |
| --- | --- | --- |
| 本地 A2A contract | ✅ Tested | `tests/test_a2a_compat_contract.py` |
| A2A live smoke | ✅ Tested | `scripts/smoke_a2a_compat.py` |
| 独立进程 A2A peer interop | ✅ Tested (v2.3.0) | [a2a-interop.md](a2a-interop.md) + `examples/a2a_interop_peer.py` |
| 第三方生态 A2A 实现 | 🟡 Not tested | 本页记录下一步计划 |

## 下一步：验证哪些第三方/外部实现

### 候选 1：Google A2A reference implementation

Google 的 A2A 协议参考实现（如果公开发布）是最直接的验证目标。

验证项：
1. Agent Card discovery — `GET /.well-known/agent-card.json`
2. `message/send` — 提交任务并收到 Task 对象
3. `message/stream` — SSE 流式返回 artifact chunks + status-update
4. `tasks/get` — 轮询任务状态
5. `tasks/cancel` — 取消进行中的任务
6. `tasks/resubscribe` — 用 `afterChunkIndex` 断线重订阅

验收标准：DeepSeek Infra 的 `A2AClient` 能消费对方 Agent Card 并完成 message/send + message/stream 全流程，artifact chunks 正确解析。

### 候选 2：CrewAI / LangGraph A2A adapter

如果 CrewAI 或 LangGraph 发布 A2A-compatible agent endpoint，验证 `A2AClient` 能向其委派任务并接收 artifact streaming。

### 候选 3：其他开源 A2A server

任何遵循 A2A JSON-RPC 2.0 + SSE contract 的独立 A2A server 实现都可作为验证目标。关键要求：
- 暴露 `/.well-known/agent-card.json`
- 支持 `message/send` 和 `message/stream`
- SSE 事件格式与 DeepSeek Infra 的 `_stream_rpc` 解析兼容

## 验证流程（当找到合适的第三方实现后）

1. 启动第三方 A2A server（独立进程，独立端口）。
2. 用 `A2AClient` 连接对方 endpoint：
   ```python
   from deepseek_infra.infra.agent_runtime.a2a import A2AClient
   client = A2AClient("http://<third-party-host>:<port>/a2a/agents/<agent-id>")
   task = client.send_message("Hello from DeepSeek Infra")
   ```
3. 验证 Agent Card / send / stream / get / cancel。
4. 把证据填入 `docs/COMPATIBILITY.md` 的 A2A Interop Compatibility 表。
5. 将 "Third-party A2A implementation" 行从 🟡 改为 ✅，补上实现名称、版本、commit、日期。

## 诚实标注

- 本页只记录计划，不声称已完成第三方生态验证。
- 兼容矩阵中 "Third-party A2A implementation" 在完成上述验证前保持 🟡。
- v2.3.0 的独立进程 peer 验证证明了 `A2AClient` 的 JSON-RPC / SSE / task lifecycle 实现是正确的，但第三方生态可能有额外的协议扩展或实现差异，需要逐个实测。
