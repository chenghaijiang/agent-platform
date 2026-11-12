"""文档解析（T05）：PDF / Markdown → 带标题层级的文本段列表。

Markdown 用 #~###### 维护标题栈生成 heading_path；PDF 按页切分（MVP 简化：
不解析字体树推断标题，页码即段落边界）。解析只产出结构，不负责切分（chunker.py）。
"""

from dataclasses import dataclass
from io import BytesIO


class UnsupportedDocumentError(Exception):
    """文档格式不支持：MVP 仅接受 PDF 与 Markdown。"""


@dataclass(frozen=True)
class ParsedSection:
    """一个连续文本段：heading_path 为标题层级路径（如 "部署/ prerequisites"），无标题时为空串。"""

    heading_path: str
    text: str


MARKDOWN_SUFFIXES = (".md", ".markdown")
SUPPORTED_SUFFIXES = MARKDOWN_SUFFIXES + (".pdf",)


def parse(filename: str, data: bytes) -> list[ParsedSection]:
    """按扩展名分派解析器；不支持格式抛 UnsupportedDocumentError。"""
    lower = filename.lower()
    if lower.endswith(MARKDOWN_SUFFIXES):
        return parse_markdown(data.decode("utf-8", errors="replace"))
    if lower.endswith(".pdf"):
        return parse_pdf(data)
    raise UnsupportedDocumentError(
        f"unsupported document type: {filename!r} (expected .pdf / .md / .markdown)"
    )


def parse_markdown(raw: str) -> list[ParsedSection]:
    """逐行扫描：标题行更新层级栈并开启新段，普通行累积到当前段。"""
    sections: list[ParsedSection] = []
    heading_stack: list[str] = []  # (级别, 文本) 仅保留文本，级别通过栈深度推断
    current: list[str] = []

    def flush() -> None:
        text = "\n".join(current).strip()
        current.clear()
        if text:
            sections.append(ParsedSection(heading_path="/".join(heading_stack), text=text))

    for line in raw.splitlines():
        stripped = line.strip()
        heading = _heading_of(stripped)
        if heading is not None:
            level, title = heading
            flush()
            # 同级标题覆盖栈顶，更深层级入栈，浅层级截断（## 出现时清掉 ### 及以下）
            del heading_stack[level - 1 :]
            heading_stack.append(title)
        elif not stripped.startswith("#") and stripped:
            # 无文本的 # 行（如 "#### "）既非标题也非正文，直接跳过
            current.append(line)
    flush()
    return sections


def _heading_of(line: str) -> tuple[int, str] | None:
    """返回（级别, 标题文本）；非标题行返回 None。无文本或闭合残行不算标题。"""
    if not line.startswith("#"):
        return None
    marks = len(line) - len(line.lstrip("#"))
    if not 1 <= marks <= 6:
        return None
    rest = line[marks:].strip()
    if not rest or rest.startswith("#"):
        return None
    return marks, rest


def parse_pdf(data: bytes) -> list[ParsedSection]:
    """PDF 按页解析：每页一个 section，heading_path 为 "第 N 页"（MVP 约定）。"""
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    sections: list[ParsedSection] = []
    for page_no, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            sections.append(ParsedSection(heading_path=f"第 {page_no} 页", text=text))
    return sections
