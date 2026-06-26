#!/usr/bin/env python3
"""语义缓存基准（离线、无需 API Key、不碰真实 .semantic-cache）。

在一个隔离的临时 SQLite 缓存上测三件事：

1. **store 延迟**：写入 N 条 Q/A（含 embedding 计算）；
2. **lookup 延迟**：精确同问 / 改写问法 / 无关问题三组查询的延迟分布；
3. **命中质量**：精确命中率（应为 1.0）、改写命中率（取决于 embedding 与阈值，
   默认零依赖 hash embedding 下偏保守是预期行为）、无关误命中率（应为 0.0）。

运行::

    python benchmarks/bench_semantic_cache.py
    python benchmarks/bench_semantic_cache.py --items 60 --json
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from deepseek_infra.infra.evaluation import harness  # noqa: E402
from deepseek_infra.infra.gateway import semantic_cache  # noqa: E402
from deepseek_infra.infra.rag import local_rag  # noqa: E402

logging.getLogger("deepseek_infra").setLevel(logging.ERROR)

MODEL = "deepseek-v4-pro"

TOPICS = [
    ("二分查找的时间复杂度是多少", "二分查找在有序数组上的时间复杂度是 O(log n)，每轮把搜索区间折半；空间复杂度迭代实现为 O(1)。前提是数据已排序且支持随机访问，否则应改用哈希或线性扫描。"),
    ("HTTP 与 HTTPS 的核心区别", "HTTPS 在 HTTP 之下加入 TLS 层：握手协商密钥后对称加密传输，提供机密性、完整性与服务器身份认证；默认端口从 80 变为 443，证书由 CA 签发并可被吊销。"),
    ("SQLite 适合什么场景", "SQLite 适合单机嵌入式场景：本地应用状态、移动端存储、边缘设备与中小流量服务。它是进程内库而非独立服务，写并发受限于单写者模型，超高并发写入应换用客户端服务器型数据库。"),
    ("什么是向量数据库的召回率", "召回率衡量检索系统找回相关文档的比例：Recall@K 表示前 K 条结果中命中相关项的查询占比。它与精确率存在权衡，评测时通常配合 MRR 与延迟一起报告。"),
    ("Python 的 GIL 是什么", "GIL（全局解释器锁）保证 CPython 同一时刻只有一个线程执行字节码：CPU 密集任务多线程无法并行，应使用多进程或 C 扩展释放锁；IO 密集任务因等待期间释放 GIL 而仍能受益。"),
    ("什么是幂等接口", "幂等接口指同一请求重复执行多次与执行一次效果相同：GET/PUT/DELETE 天然幂等，POST 需要业务侧用幂等键去重。它是重试机制安全的前提，也是消息至少一次投递语义下的标配。"),
    ("解释一下 prompt cache", "Prompt cache 复用请求前缀的推理结果：只要 system 提示与工具定义字节级稳定，后续轮次的公共前缀就能命中缓存，显著降低首 token 延迟与成本；动态内容应放到 prompt 尾部。"),
    ("BM25 和向量检索怎么选", "BM25 擅长精确词法匹配且零训练成本，向量检索擅长同义与跨语言语义匹配；生产中常用混合检索把两路得分融合排序，再按需加重排器，兼顾召回与精度。"),
]

PARAPHRASES = [
    "二分查找的复杂度是什么量级？",
    "HTTPS 相比 HTTP 多了什么？",
    "SQLite 的适用场景有哪些？",
    "向量检索里的召回率是什么意思？",
    "Python 全局解释器锁起什么作用？",
    "接口幂等性是什么意思？",
    "prompt cache 的原理是什么？",
    "全文检索 BM25 与稠密向量如何取舍？",
]

UNRELATED = [
    "今天北京的天气怎么样",
    "推荐三部科幻电影",
    "如何煮出溏心蛋",
]


def body_for(question: str) -> dict[str, Any]:
    return {"model": MODEL, "messages": [{"role": "user", "content": question}]}


def configure_embedding_provider(provider: str, *, onnx_model: str = "", tokenizer: str = "", dimensions: int = 0) -> None:
    local_rag.LOCAL_RAG_EMBEDDING_PROVIDER = str(provider or "hash")
    if onnx_model:
        local_rag.LOCAL_RAG_ONNX_MODEL_PATH = onnx_model
    if tokenizer:
        local_rag.LOCAL_RAG_TOKENIZER_PATH = tokenizer
    if dimensions > 0:
        local_rag.LOCAL_RAG_EMBEDDING_DIMENSIONS = dimensions
    local_rag.reset_embedding_pipeline()


def run_benchmark(items: int) -> dict[str, Any]:
    pairs = [TOPICS[index % len(TOPICS)] for index in range(items)]
    store_latencies: list[float] = []
    for index, (question, answer) in enumerate(pairs):
        unique_question = question if index < len(TOPICS) else f"{question}（变体 {index // len(TOPICS)}）"
        started = time.perf_counter()
        diagnostics = semantic_cache.store({}, body_for(unique_question), {"content": answer, "usage": {"total_tokens": 200}})
        store_latencies.append((time.perf_counter() - started) * 1000.0)
        if not diagnostics.get("stored"):
            print(f"warning: store skipped: {diagnostics.get('storeSkippedReason')}", file=sys.stderr)

    def lookup_round(questions: list[str]) -> tuple[int, list[float], list[float]]:
        hits = 0
        latencies: list[float] = []
        similarities: list[float] = []
        for question in questions:
            started = time.perf_counter()
            lookup = semantic_cache.lookup({}, body_for(question))
            latencies.append((time.perf_counter() - started) * 1000.0)
            similarities.append(float(lookup.diagnostics.get("similarity") or 0.0))
            if lookup.hit:
                hits += 1
        return hits, latencies, similarities

    exact_questions = [question for question, _ in pairs[: len(TOPICS)]]
    exact_hits, exact_latencies, _ = lookup_round(exact_questions)
    paraphrase_hits, paraphrase_latencies, paraphrase_similarities = lookup_round(PARAPHRASES)
    unrelated_hits, unrelated_latencies, _ = lookup_round(UNRELATED)

    status = semantic_cache.status()
    return {
        "suite": "bench_semantic_cache",
        "items": items,
        "threshold": status.get("similarityThreshold"),
        "requestedProvider": local_rag.LOCAL_RAG_EMBEDDING_PROVIDER,
        "embeddingProvider": status.get("embeddingProvider"),
        "embeddingDimensions": status.get("embeddingDimensions"),
        "lastError": status.get("lastError"),
        "storeLatencyMs": harness.latency_benchmark(store_latencies),
        "lookupLatencyMs": harness.latency_benchmark(exact_latencies + paraphrase_latencies + unrelated_latencies),
        "exactHitRate": round(exact_hits / len(exact_questions), 4) if exact_questions else 0.0,
        "paraphraseHitRate": round(paraphrase_hits / len(PARAPHRASES), 4),
        "paraphraseAvgSimilarity": round(sum(paraphrase_similarities) / len(paraphrase_similarities), 4) if paraphrase_similarities else 0.0,
        "unrelatedFalseHitRate": round(unrelated_hits / len(UNRELATED), 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline semantic cache benchmark")
    parser.add_argument("--items", type=int, default=40, help="写入缓存的条目数")
    parser.add_argument("--provider", choices=("hash", "onnx"), default="hash", help="Embedding provider to benchmark")
    parser.add_argument("--onnx-model", default="", help="ONNX embedding model path, required for --provider onnx")
    parser.add_argument("--tokenizer", default="", help="Tokenizer JSON path, required for --provider onnx")
    parser.add_argument("--dimensions", type=int, default=0, help="Override embedding dimensions for the benchmark")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    cache_dir = Path(tempfile.mkdtemp(prefix="semcache-bench-"))
    # 与 tests/conftest 相同的隔离手法：模块级路径指到临时目录并强制启用。
    semantic_cache.SEMANTIC_CACHE_ENABLED = True
    semantic_cache.SEMANTIC_CACHE_DIR = cache_dir
    semantic_cache.SEMANTIC_CACHE_DB = cache_dir / "cache.sqlite3"
    configure_embedding_provider(
        args.provider,
        onnx_model=args.onnx_model,
        tokenizer=args.tokenizer,
        dimensions=args.dimensions,
    )
    try:
        report = run_benchmark(max(len(TOPICS), args.items))
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    store = report["storeLatencyMs"]
    lookup = report["lookupLatencyMs"]
    print("=== Benchmark · Semantic cache (offline) ===")
    print(
        f"Items stored: {report['items']} · requested={report['requestedProvider']} "
        f"· active={report['embeddingProvider']}({report['embeddingDimensions']}d) · threshold={report['threshold']}"
    )
    if report.get("lastError"):
        print(f"Embedding note: {report['lastError']}")
    print(f"Store latency:  avg {store['avgMs']:.1f} ms · P50 {store['p50Ms']:.1f} ms · P95 {store['p95Ms']:.1f} ms")
    print(f"Lookup latency: avg {lookup['avgMs']:.1f} ms · P50 {lookup['p50Ms']:.1f} ms · P95 {lookup['p95Ms']:.1f} ms")
    print(f"Exact-repeat hit rate: {report['exactHitRate']:.2f}（应为 1.00）")
    print(f"Paraphrase hit rate: {report['paraphraseHitRate']:.2f}（avg similarity {report['paraphraseAvgSimilarity']:.2f}；零依赖 hash embedding 下偏保守是预期）")
    print(f"Unrelated false-hit rate: {report['unrelatedFalseHitRate']:.2f}（应为 0.00）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
