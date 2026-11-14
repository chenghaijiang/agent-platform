"""payment-console 计价模块：套餐月费、席位加购与年付。

金额单位统一为「分」，避免浮点误差；三档套餐价格与席位/年付规则见产品需求。
"""

BASE_PRICES_CENTS = {"starter": 2900, "team": 8900, "enterprise": 29900}
INCLUDED_SEATS = 5
EXTRA_SEAT_RATE_PERCENT = 10  # 超出基础席位的加购席位：按基础价的 10%/席 计费
ANNUAL_PROMO_MONTHS = 10  # 年付促销：按 10 个月计费（赠 2 个月）


def monthly_price_cents(plan: str, seats: int = 1) -> int:
    """月费（分）：基础价 + 超出 INCLUDED_SEATS 的席位按基础价 10%/席 加收。"""
    if plan not in BASE_PRICES_CENTS:
        raise ValueError(f"unknown plan: {plan}")
    if seats < 1:
        raise ValueError("seats must be positive")
    base = BASE_PRICES_CENTS[plan]
    extra_seats = max(seats - INCLUDED_SEATS, 0)
    return base + extra_seats * base * EXTRA_SEAT_RATE_PERCENT // 100


def annual_price_cents(plan: str, seats: int = 1) -> int:
    """年付价格（分）：按 ANNUAL_PROMO_MONTHS 个月计费。

    预置缺陷（AgentDesk 演示任务的修复目标）：此处硬编码 12 个月，
    未使用 ANNUAL_PROMO_MONTHS 常量，年付促销用例因此失败。
    """
    return monthly_price_cents(plan, seats) * 12
