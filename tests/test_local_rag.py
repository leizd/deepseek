from __future__ import annotations

import json

import deepseek_mobile.services.local_rag as local_rag


def test_local_rag_indexes_and_searches_file_chunks(tmp_settings) -> None:
    cached = {
        "id": "a" * 32,
        "name": "guide.txt",
        "kind": "text",
        "chunks": [
            {"index": 0, "text": "alpha beta gamma", "lineStart": 1, "lineEnd": 1},
            {"index": 1, "text": "sqlite vector database for local rag", "lineStart": 2, "lineEnd": 2},
        ],
    }

    indexed = local_rag.index_file_payload(cached)
    results = local_rag.search_files_index("local vector database", limit=3)
    status = local_rag.status()

    assert indexed == 2
    assert results
    assert results[0].source_id == "a" * 32
    assert results[0].chunk_index == 1
    assert status["indexedItems"] >= 2
    assert status["indexedFiles"] >= 1


def test_local_rag_syncs_memory_items(tmp_settings) -> None:
    memories = [
        {
            "id": "m1",
            "content": "Project alpha prefers SQLite local RAG.",
            "category": "project",
            "scope": "project:alpha",
            "source": "manual",
        },
        {
            "id": "m2",
            "content": "Prefers concise answers.",
            "category": "preference",
            "scope": "global",
            "source": "manual",
        },
    ]

    indexed = local_rag.sync_memories(memories)
    hits = local_rag.search_memories_index("SQLite local retrieval", scopes=["project:alpha"], limit=5)

    assert indexed == 2
    assert hits
    assert hits[0].source_id == "m1"
    assert hits[0].scope == "project:alpha"


def test_local_rag_rebuild_scans_existing_cache_and_memory(tmp_settings) -> None:
    file_cache = tmp_settings / ".file-cache"
    memory_dir = tmp_settings / ".memory"
    file_cache.mkdir(parents=True)
    memory_dir.mkdir(parents=True)
    (file_cache / f"{'b' * 32}.json").write_text(
        json.dumps(
            {
                "id": "b" * 32,
                "name": "notes.md",
                "kind": "markdown",
                "chunks": [{"index": 0, "text": "chunking vectorization local sqlite", "lineStart": 1, "lineEnd": 1}],
            }
        ),
        encoding="utf-8",
    )
    (memory_dir / "memories.json").write_text(
        json.dumps(
            [
                {
                    "id": "m-local",
                    "content": "User wants 100 percent local RAG.",
                    "category": "project",
                    "scope": "global",
                }
            ]
        ),
        encoding="utf-8",
    )

    result = local_rag.rebuild_index()

    assert result["ok"] is True
    assert result["files"] == 1
    assert result["chunks"] == 1
    assert result["memories"] == 1
    assert local_rag.search_files_index("sqlite vector", limit=2)
    assert local_rag.search_memories_index("local rag", scopes=["global"], limit=2)
