"""脱敏与敏感识别策略（T08，ADR-007）：纯函数，无 DB / 框架依赖。

MVP 策略：手机号与身份证号两类强敏感个人标识。
- 输入（提问）：进入检索与模型前脱敏，避免敏感信息进入日志与模型上下文
- 输出（回答）：识别敏感信息并处置——脱敏后返回（disposition=masked），处置方式明确
"""

import re
from dataclasses import dataclass

# 手机号：1[3-9] 开头的 11 位数字；身份证：17 位数字 + 校验位（数字或 X）。
# 前后向断言排除长数字串的内部子串误匹配。
PHONE_PATTERN = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
IDCARD_PATTERN = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")


@dataclass(frozen=True)
class MaskFinding:
    """一次敏感命中：类型与出现次数（审计 detail 记录用）。"""

    type: str  # phone / idcard
    count: int


@dataclass(frozen=True)
class ScreenResult:
    text: str
    findings: list[MaskFinding]
    disposition: str  # passthrough（无命中）/ masked（已脱敏）


def _mask_phone(match: re.Match) -> str:
    phone = match.group(0)
    return f"{phone[:3]}****{phone[7:]}"


def _mask_idcard(match: re.Match) -> str:
    idc = match.group(0)
    return f"{idc[:6]}********{idc[14:]}"


def screen_text(text: str) -> ScreenResult:
    """识别并脱敏文本中的敏感信息；无命中时原文透传。"""
    findings: list[MaskFinding] = []
    masked, phone_count = PHONE_PATTERN.subn(_mask_phone, text)
    if phone_count:
        findings.append(MaskFinding(type="phone", count=phone_count))
    masked, idcard_count = IDCARD_PATTERN.subn(_mask_idcard, masked)
    if idcard_count:
        findings.append(MaskFinding(type="idcard", count=idcard_count))
    return ScreenResult(
        text=masked,
        findings=findings,
        disposition="masked" if findings else "passthrough",
    )


# 语义命名：输入侧脱敏与输出侧识别共用同一 MVP 策略，后续可分别演化
mask_input = screen_text
screen_output = screen_text
