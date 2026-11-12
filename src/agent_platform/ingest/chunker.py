"""切分器（T05）：ParsedSection → 定长知识块，保留标题层级为元数据。

策略：段内按空行分段聚合到 max_chars；单段超长按字符硬切。
不追求语义最优切分，MVP 保证：块不超长、heading_path 可追溯、内容有序。
"""

from dataclasses import dataclass

from agent_platform.ingest.parser import ParsedSection

DEFAULT_MAX_CHARS = 1000


@dataclass(frozen=True)
class Chunk:
    heading_path: str
    content: str


def chunk_sections(sections: list[ParsedSection], max_chars: int = DEFAULT_MAX_CHARS) -> list[Chunk]:
    """聚合切分。空 sections 返回空列表（由上游判定为解析失败而非静默成功）。"""
    chunks: list[Chunk] = []
    for section in sections:
        for piece in _split_to_pieces(section.text, max_chars):
            chunks.append(Chunk(heading_path=section.heading_path, content=piece))
    return chunks


def _split_to_pieces(text: str, max_chars: int) -> list[str]:
    """先把文本切成不超过 max_chars 的原子片段，再把相邻片段聚合回接近 max_chars 的块。"""
    atoms: list[str] = []
    for paragraph in text.split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        for i in range(0, len(paragraph), max_chars):
            atoms.append(paragraph[i : i + max_chars])

    pieces: list[str] = []
    buffer = ""
    for atom in atoms:
        candidate = f"{buffer}\n\n{atom}" if buffer else atom
        if len(candidate) <= max_chars:
            buffer = candidate
        else:
            if buffer:
                pieces.append(buffer)
            buffer = atom
    if buffer:
        pieces.append(buffer)
    return pieces
