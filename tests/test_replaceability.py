"""认证层可替换性测试（T02 验收项）：以 fake 第二实现证明业务代码不感知认证方式。

核心断言：同一个 app、同一条业务路由 /api/me，仅替换 AuthProvider 实现，
行为随实现切换——业务代码零改动。
"""

import pytest
from fastapi.testclient import TestClient

from agent_platform.auth.deps import get_auth_provider
from agent_platform.auth.fake_oidc import FakeOidcProvider
from agent_platform.main import app as default_app


@pytest.fixture()
def fake_app():
    """默认 app 上仅 override 装配点，把认证实现换成 fake OIDC。"""
    default_app.dependency_overrides[get_auth_provider] = lambda: FakeOidcProvider()
    yield default_app
    default_app.dependency_overrides.clear()


def test_local_default_rejects_missing_token() -> None:
    """默认（本地口令实现）下：无 token → 401。"""
    with TestClient(default_app) as client:
        resp = client.get("/api/me")
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def test_fake_provider_serves_same_route(fake_app) -> None:
    """fake 第二实现下：fake 登录 → 同一 /api/me 返回 200 且身份来自 fake。"""
    with TestClient(fake_app) as client:
        login = client.post(
            "/api/auth/login", json={"username": "anyone", "password": "irrelevant"}
        )
        assert login.status_code == 200
        assert login.json()["user"]["role"] == "member"

        token = login.json()["access_token"]
        resp = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["username"] == "anyone"
        assert body["role"] == "member"
        assert body["auth_provider"] == "fake-oidc"


def test_fake_token_not_accepted_by_local_implementation() -> None:
    """两种实现 secret 隔离：fake 签发的 token 拿到本地实现下是无效凭证（401）。"""
    import anyio

    token = anyio.run(FakeOidcProvider().login, "anyone", "x").token.access_token

    with TestClient(default_app) as client:
        resp = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401


def test_local_token_not_accepted_by_fake_implementation() -> None:
    """反向同样隔离：本地签发的 token 在 fake verify 下无效。"""
    from agent_platform.auth.tokens import issue_access_token

    token, _ = issue_access_token(user_id="u1", username="alice", role="admin")
    import anyio

    context = anyio.run(FakeOidcProvider().verify, token)
    assert context is None
