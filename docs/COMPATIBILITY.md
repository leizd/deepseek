# Compatibility Matrix（兼容性矩阵）

适用版本：v2.2.4。

这页只记录已经可复现的互操作结果，不把“协议上应该兼容”写成“实机已验证”。v2.2.4 的重点是把 A2A Agent Mesh 从 Experimental 推到 MVP：artifact chunks、`tasks/resubscribe`、本地 external peer loopback、trace/metrics 和取消生命周期都有可跑证据；真实第三方 A2A 实现仍待补进矩阵。MCP Tool Hub 已在 v2.2.3 推到 MVP，Claude Desktop 和 Cursor 的配置片段已补齐，但本机未安装这两个客户端，因此 GUI 实机项仍标为待跑。

## MCP Client Compatibility

| Client / Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `examples/mcp_tool_demo.py` | ✅ Tested | `python examples/mcp_tool_demo.py` | 本地 Python MCP client，覆盖 `initialize` / `tools/list` / `tools/call`。 |
| MCP test suite (`tests/test_mcp.py`) | ✅ Tested | CI + local pytest | 覆盖握手、目录、能力切片、工具执行、错误码、loopback client、外部 server profile、policy gate、结果清洗、trace diagnostics。 |
| `curl` JSON-RPC | ✅ Tested | `POST /mcp` | 适合排查 token、协议响应和工具目录。 |
| Claude Desktop | 🟡 Config documented | [integrations/claude-desktop.md](integrations/claude-desktop.md) | 本机未安装 Claude Desktop，未标为实机通过。DeepSeek Infra 端的 Streamable HTTP endpoint 已可用。 |
| Cursor | 🟡 Config documented | [integrations/cursor.md](integrations/cursor.md) | 本机未安装 Cursor，未标为实机通过。Cursor MCP 配置片段与排障步骤已补。 |
| Continue.dev | 🔲 Not tested | - | 待补配置和实机验证。 |

## MCP External Server Bridge

v2.2.1 起，外部 MCP server 的工具会以 `mcp__<server>__<tool>` 桥接进本地 Agent 工具面；v2.2.2 起，Agent 调用和 `/mcp tools/call` 都共享 executor 内部 ToolPolicy 闸门，远端 `isError=true` 会映射为本地 `upstream_tool_error`。

## External MCP Server Bridging

| Scenario | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Local mock external MCP server | ✅ Tested | `tests/test_mcp.py` | `MCPClient` 消费外部 `tools/list`，生成 `mcp__<server>__<tool>` profiles。 |
| External tool policy gate | ✅ Tested | `tests/test_mcp.py` | 高风险/敏感参数进入 Tool Policy，拒绝时不会触达外部 server。 |
| External server unavailable | ✅ Tested | `tests/test_mcp.py` | 外部 server 失败不影响本地 MCP tools。 |
| Timeout / retry stats | ✅ Tested | `test_client_retries_retryable_transport_failures` | `MCPClient.last_stats` 记录 attempts、retry count、latency、timeout/error type。 |
| Circuit breaker | ✅ Tested | `test_external_mcp_registry_reports_health_and_opens_circuit` | 连续失败后进入短期 `circuit_open`，`/api/mcp/external/tools` 返回健康态。 |
| Trace diagnostics | ✅ Tested | `test_external_mcp_call_records_trace_diagnostics` | `mcp_external` span 记录 latency、attempts、retryCount、timeout、errorType。 |
| Real third-party Streamable HTTP MCP server | 🔲 Not tested in this workspace | - | 需要选择一个稳定公开/本地第三方 server 后补实测记录。 |

## Current MCP MVP Acceptance

| Acceptance item | v2.2.4 result |
| --- | --- |
| 本地 MCP server | ✅ `POST /mcp` + examples + CI |
| 本地 mock external MCP server | ✅ CI |
| Claude Desktop | 🟡 配置文档已补，GUI 未实机 |
| Cursor | 🟡 配置文档已补，GUI 未实机 |
| 一个真实外部 MCP server | 🔲 待实机 |
| 外部 server 挂掉 | ✅ health + local tools unaffected |
| schema/响应异常 | ✅ invalid JSON / malformed tool catalog mapped to upstream failure |
| 工具超时/重试 | ✅ client stats + trace diagnostics |
| 危险参数拦截 | ✅ Tool Policy gate |

## Health API

`GET /api/mcp/external/tools` 返回：

- `servers[]`: `available`、`status`、`timeoutSeconds`、`consecutiveFailures`、`lastError`、`lastErrorType`、`lastRefreshAt`、`lastLatencyMs`、`lastRetryCount`、`circuitOpenSeconds`
- `tools[]`: `server`、`tool`、`bridgedName`、`risk`、`network`、`filesystem`、`requiresApproval`

## OpenAI API Compatibility

| Client | Status | Evidence |
| --- | --- | --- |
| OpenAI Python SDK (`openai>=1.0`) | ✅ Tested | `examples/openai_compatible_client.py` |
| `curl` | ✅ Tested | README examples |
| Ollama as provider | ✅ Tested | `OLLAMA_ENABLED=1` exposes `ollama/<tag>` through `/v1/models` |
| Other OpenAI-compatible SDKs | 🔲 Not tested | Should work with standard `/v1/chat/completions` and `/v1/models`, but not claimed here. |

## A2A Interop Compatibility

| Peer | Status | Evidence |
| --- | --- | --- |
| Local A2A test suite (`tests/test_a2a.py`) | ✅ Tested | 14 cases: artifact chunks, `tasks/resubscribe`, canceling, loopback client, metrics |
| Local Agent Card discovery | ✅ Tested | `GET /.well-known/agent-card.json` |
| Local external A2A peer loopback | ✅ Tested | `examples/a2a_peer_demo.py` against `http://127.0.0.1:8001/a2a/agents/reasoner` |
| Third-party A2A implementation | 🔲 Not tested | Ecosystem interop still pending; not claimed as passed. |

## A2A MVP Acceptance

| Acceptance item | v2.2.4 result |
| --- | --- |
| Artifact streaming chunks | ✅ `artifactId` / `chunkIndex` / `append` / `final` in `artifact-update` SSE events |
| `tasks/resubscribe` | ✅ Reconnect by `taskId` and `afterChunkIndex` |
| Local external peer loopback | ✅ `A2AClient.message_stream()` + `examples/a2a_peer_demo.py` |
| A2A trace / metrics | ✅ `a2a_task` / `a2a_peer_call` spans + `ai_a2a_*` Prometheus metrics |
| Cancellation lifecycle | ✅ `cancelRequestedAt`, `canceling -> canceled`, `discardedResult` trace diagnostics |
