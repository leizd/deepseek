from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from deepseek_infra.services import reminders


def test_create_and_mark_due_reminder(tmp_settings) -> None:
    due_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()

    created = reminders.create_reminder({"title": "晨会", "content": "准备要点", "dueAt": due_at})
    due = reminders.due_reminders(datetime.now(timezone.utc))
    remaining = reminders.load_reminders()

    assert created["id"]
    assert due[0]["title"] == "晨会"
    assert remaining[0]["notified"] is True


def test_due_reminders_compares_datetimes_across_iso_precisions(tmp_settings) -> None:
    due_at = datetime(2026, 5, 10, 8, 0, 0, tzinfo=timezone.utc).isoformat()
    now = datetime(2026, 5, 10, 8, 0, 0, 500000, tzinfo=timezone.utc)

    created = reminders.create_reminder({"title": "precision", "dueAt": due_at})
    due = reminders.due_reminders(now)

    assert due[0]["id"] == created["id"]


def test_parse_natural_reminder_extracts_chinese_time() -> None:
    now = datetime(2026, 5, 10, 8, 0, 0)

    parsed = reminders.parse_natural_reminder("明早 9 点提醒我准备晨会要点", now=now)

    assert parsed is not None
    assert parsed["content"] == "准备晨会要点"
    assert "2026-05-11T09:00:00" in parsed["dueAt"]


def test_parse_due_at_rejects_bad_value() -> None:
    with pytest.raises(Exception):
        reminders.parse_due_at("not a date")
