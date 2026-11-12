"""口令哈希原语单测（T02 验收：加盐哈希存储，不落明文）。"""

from agent_platform.core.security import hash_password, verify_password


def test_roundtrip_correct_password() -> None:
    stored = hash_password("S3cret-Pass!")
    assert verify_password("S3cret-Pass!", stored) is True


def test_wrong_password_rejected() -> None:
    stored = hash_password("correct")
    assert verify_password("wrong", stored) is False


def test_salt_is_random_per_call() -> None:
    """同一口令两次哈希结果不同（随机盐），但都能校验通过。"""
    a = hash_password("same-password")
    b = hash_password("same-password")
    assert a != b
    assert verify_password("same-password", a)
    assert verify_password("same-password", b)


def test_stored_format_has_no_plaintext_and_declares_algorithm() -> None:
    stored = hash_password("my-plain-secret")
    assert stored.startswith("pbkdf2_sha256$")
    assert "my-plain-secret" not in stored  # 口令与明文形态均不出现
    assert len(stored.split("$")) == 4  # algo$iterations$salt$digest


def test_malformed_stored_value_rejected() -> None:
    assert verify_password("x", "not-a-valid-hash") is False
    assert verify_password("x", "bcrypt$1$abc$def") is False  # 算法不匹配
