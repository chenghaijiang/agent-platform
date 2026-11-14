"""payment-console 计价模块测试：年付促销两条用例因预置缺陷失败（pytest -q 可见）。"""

import pytest

from pricing import annual_price_cents, monthly_price_cents

BASE_PRICES = {"starter": 2900, "team": 8900, "enterprise": 29900}


def test_monthly_price_base_plans():
    for plan, price in BASE_PRICES.items():
        assert monthly_price_cents(plan) == price


def test_monthly_price_extra_seats_charged_at_ten_percent():
    # 超出 5 个基础席位后，每个加购席位按基础价 10% 计费
    assert monthly_price_cents("starter", seats=6) == 2900 + 290
    assert monthly_price_cents("team", seats=7) == 8900 + 2 * 890
    assert monthly_price_cents("enterprise", seats=5) == 29900


def test_monthly_price_rejects_unknown_plan():
    with pytest.raises(ValueError):
        monthly_price_cents("platinum")


def test_monthly_price_rejects_non_positive_seats():
    with pytest.raises(ValueError):
        monthly_price_cents("starter", seats=0)


def test_annual_price_grants_two_free_months():
    # 年付促销：按 10 个月计费（赠 2 个月）
    assert annual_price_cents("team") == 8900 * 10


def test_annual_price_follows_seat_pricing():
    assert annual_price_cents("starter", seats=6) == (2900 + 290) * 10
