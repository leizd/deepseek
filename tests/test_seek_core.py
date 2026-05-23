from __future__ import annotations

import subprocess
import textwrap
import unittest


def run_seek_core(script: str) -> None:
    code = (
        "const fs = require('fs');\n"
        "const vm = require('vm');\n"
        "const assert = require('assert');\n"
        "const context = { console };\n"
        "context.globalThis = context;\n"
        "vm.createContext(context);\n"
        "vm.runInContext(fs.readFileSync('static/seek_core.js', 'utf8'), context);\n"
        "const C = context.DeepSeekSeekCore;\n"
        + textwrap.dedent(script)
    )
    subprocess.run(["node", "-e", code], check=True)


class SeekCoreTests(unittest.TestCase):
    def test_normalize_text_truncates_by_code_point(self) -> None:
        run_seek_core(
            """
            const value = C.normalizeSeekText('一二三四五六七八九十🙂', 10);
            assert.strictEqual(Array.from(value).length, 10);
            assert.strictEqual(value, '一二三四五六七八九十');

            const emoji = C.normalizeSeekText('123456789🙂', 10);
            assert.strictEqual(Array.from(emoji).length, 10);
            assert.strictEqual(emoji.endsWith('🙂'), true);
            assert.strictEqual(emoji.includes('\\uFFFD'), false);
            """
        )

    def test_custom_seek_limit_is_applied_when_normalizing_for_storage(self) -> None:
        run_seek_core(
            """
            const items = Array.from({ length: 50 }, (_, index) => ({
              id: `seek-${index}`,
              name: `Seek ${index}`,
              instructions: 'do useful work',
            }));
            const normalized = C.normalizeCustomSeeks(items, { now: 123 });
            assert.strictEqual(normalized.length, 40);
            assert.strictEqual(normalized[39].id, 'seek-39');
            """
        )

    def test_deleted_seek_snapshot_still_resolves_for_history(self) -> None:
        run_seek_core(
            """
            const message = {
              seekId: 'deleted-seek',
              seekName: '旧助手',
              seekDescription: '已经删除',
              seekInstructions: '仍然按旧指令回答',
              seekReferenceAttachments: [
                { id: 'ref-1', name: '旧资料.pdf', fileId: 'abc', kind: 'pdf', charCount: 1200 },
              ],
            };
            const resolved = C.resolveSeekContext(message, []);
            assert.strictEqual(resolved.name, '旧助手');
            assert.strictEqual(resolved.referenceAttachments.length, 1);
            assert.strictEqual(resolved.referenceAttachments[0].name, '旧资料.pdf');
            assert.strictEqual(C.seekNameForMessage(message, []), '旧助手');
            """
        )

    def test_reference_attachments_are_normalized_and_limited(self) -> None:
        run_seek_core(
            """
            let nextId = 0;
            const attachments = Array.from({ length: 8 }, (_, index) => ({
              name: `资料 ${index}.txt`,
              fileId: `file-${index}`,
              kind: 'text',
              charCount: 100 + index,
            }));
            const seek = C.normalizeSeek(
              { id: 'seek-ref', name: '资料助手', instructions: '参考资料回答', referenceAttachments: attachments },
              { now: 123, createId: () => `id-${nextId++}` }
            );
            assert.strictEqual(seek.referenceAttachments.length, C.maxSeekReferenceAttachments);
            assert.strictEqual(seek.referenceAttachments[0].id, 'seek-ref-id-0');

            const snapshot = C.seekSnapshotFromSeek(seek);
            assert.strictEqual(snapshot.seekReferenceAttachments.length, 6);
            assert.strictEqual(snapshot.seekReferenceAttachments[5].fileId, 'file-5');
            """
        )

    def test_duplicate_names_and_dead_ids_are_detected(self) -> None:
        run_seek_core(
            """
            const seeks = [
              { id: 'preset-research', name: '研究分析', instructions: 'a' },
              { id: 'seek-1', name: '考研导师', instructions: 'b' },
            ];
            assert.strictEqual(C.hasDuplicateSeekName(seeks, '考研导师'), true);
            assert.strictEqual(C.hasDuplicateSeekName(seeks, '考研导师', 'seek-1'), false);
            assert.strictEqual(C.latestKnownSeekId([{ seekId: 'dead' }, { seekId: 'seek-1' }], seeks), 'seek-1');
            assert.strictEqual(C.latestKnownSeekId([{ seekId: 'dead' }], seeks), '');
            """
        )

    def test_export_payload_and_import_merge_are_stable(self) -> None:
        run_seek_core(
            """
            const exported = C.seekExportPayload([{ id: 'seek-a', name: '考研', instructions: '讲题' }], { exportedAt: '2026-05-09T00:00:00Z' });
            assert.strictEqual(exported.type, 'deepseek-mobile.seeks');
            assert.strictEqual(exported.version, 2);
            assert.strictEqual(exported.seeks.length, 1);

            let nextId = 0;
            const result = C.mergeImportedSeeks(
              [{ id: 'seek-a', name: '考研', instructions: '讲题' }],
              { seeks: [
                { id: 'seek-a', name: '考研', instructions: '新的指令' },
                { id: 'seek-bad', name: '', instructions: '' },
              ] },
              [{ id: 'preset-study', name: '学习导师', instructions: 'a' }],
              { now: 123, createId: () => `imported-${nextId++}` }
            );
            assert.strictEqual(result.importedCount, 1);
            assert.strictEqual(result.skippedCount, 1);
            assert.strictEqual(result.seeks[0].id, 'seek-imported-0');
            assert.strictEqual(result.seeks[0].name, '考研 副本');
            assert.strictEqual(result.seeks[0].builtin, false);
            """
        )


if __name__ == "__main__":
    unittest.main()
