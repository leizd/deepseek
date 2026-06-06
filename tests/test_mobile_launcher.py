from __future__ import annotations

from deepseek_infra.launcher import mobile


def test_mobile_environment_detects_android_markers() -> None:
    assert mobile.is_mobile_environment({"ANDROID_ROOT": "/system"}) is True
    assert mobile.is_mobile_environment({"TERMUX_VERSION": "0.118"}) is True
    assert mobile.is_mobile_environment({}) is False


def test_mobile_configure_environment_sets_local_defaults(monkeypatch) -> None:
    for key in [
        "DEEPSEEK_API_KEY",
        "HOST",
        "OCR_ENABLED",
        "PORT",
        "PYTHONIOENCODING",
        "PYTHONUTF8",
        "TAVILY_API_KEY",
    ]:
        monkeypatch.delenv(key, raising=False)
    args = mobile.parse_args(["--port", "8123", "--api-key", "sk-phone", "--no-prompt", "--no-open"])

    host, port = mobile.configure_environment(args)

    assert host == "127.0.0.1"
    assert port == 8123
    assert mobile.os.environ["HOST"] == "127.0.0.1"
    assert mobile.os.environ["PORT"] == "8123"
    assert mobile.os.environ["DEEPSEEK_API_KEY"] == "sk-phone"
    assert mobile.os.environ["OCR_ENABLED"] == "0"
    assert mobile.os.environ["PYTHONIOENCODING"] == "utf-8"
    assert mobile.os.environ["PYTHONUTF8"] == "1"


def test_mobile_configure_environment_supports_lan_auth_and_ocr(monkeypatch) -> None:
    monkeypatch.delenv("AUTH_DISABLED", raising=False)
    args = mobile.parse_args(["--lan", "--auth-disabled", "--ocr", "--tavily-api-key", "tvly-phone", "--no-prompt"])

    host, _ = mobile.configure_environment(args)

    assert host == "0.0.0.0"
    assert mobile.os.environ["HOST"] == "0.0.0.0"
    assert mobile.os.environ["AUTH_DISABLED"] == "1"
    assert mobile.os.environ["OCR_ENABLED"] == "1"
    assert mobile.os.environ["TAVILY_API_KEY"] == "tvly-phone"


def test_mobile_parse_port_rejects_invalid_values() -> None:
    for value in ["0", "65536", "abc"]:
        try:
            mobile.parse_port(value)
        except Exception as exc:
            assert exc.__class__.__name__ == "ArgumentTypeError"
        else:
            raise AssertionError(f"expected parse error for {value}")
