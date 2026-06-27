# Eval Reports

适用版本：v2.2.7。

v2.2.7 把 RAG、Tool Policy 和 Prompt Injection adversarial eval 从分散 CLI 输出升级为一份可归档、可比较、可上传到 CI artifact 的离线评测报告。目标不是扩大门禁面，而是沉淀证据：每次 PR 都能看到当前分数、版本信息、数据集规模和相对 v2.2.6 baseline 的退化判断。

## 本地复跑

```bash
python evals/runners/run_offline_eval_suite.py \
  --out evals/reports/latest.json \
  --markdown evals/reports/latest.md

python evals/runners/compare_eval_baseline.py \
  --baseline evals/baselines/v2.2.6.json \
  --current evals/reports/latest.json
```

也可以用封装脚本一次完成刷新和对比：

```bash
python scripts/update_eval_report.py
```

## 报告内容

`evals/reports/latest.json` 是机器可读证据，包含：

- `version` / `gitSha` / `gitDirty` / `generatedAt`：报告归属的代码状态。
- `rag.recallAt5`、`rag.citationAccuracy`、`rag.mrr`：离线 RAG 检索和引用指标。
- `toolPolicy.passRate`、`toolPolicy.injectionDefensePassRate`：真实 ToolPolicy / sanitizer / taint 用例通过率。
- `injection.blockRate`、`injection.falsePositiveRate`、`injection.bypassRate`、`injection.softGate`：对抗注入 soft gate 指标。

`evals/reports/latest.md` 是给 PR 审查看的摘要表；CI 会把这两份文件作为 `offline-eval-report` artifact 上传。

## 回归比较

`evals/baselines/v2.2.6.json` 固化 v2.2.6 稳定离线评测基线。`compare_eval_baseline.py` 使用以下规则：

| Metric | Warning | Fail |
| --- | --- | --- |
| RAG Recall@5 | 有下降但不超过 0.02 | 下降超过 0.02 |
| Citation Accuracy | 有下降但不超过 0.02 | 下降超过 0.02 |
| Tool Policy Pass Rate | 无 warning 档 | 任何下降 |
| Injection Bypass Rate | 上升但不超过 0.05 | 上升超过 0.05 |
| Injection False Positive Rate | 上升但不超过 0.05 | 上升超过 0.05 |

`WARNING` 会保留 CI 绿色但提醒审查；`FAIL` 返回非零退出码并阻断 eval job。

## 更新 baseline

只在明确发布新的稳定版本时更新 baseline。推荐流程：

1. 先合入修复，确保 `latest.json` 的退化比较为 `PASS`。
2. 发布版本时把 `evals/reports/latest.json` 复制为新的 `evals/baselines/vX.Y.Z.json`。
3. 更新 CI 的 `--baseline` 参数和本文档中的 baseline 版本。

不要把带时间戳的 `evals/reports/<suite>-*.json` 提交进仓库；它们仍是本地产物。仓库只跟踪 `latest.json` / `latest.md` 和版本化 baseline。
