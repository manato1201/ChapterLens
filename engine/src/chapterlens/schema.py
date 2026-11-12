"""「区間と意味のデータ」(chapterlens/segments@1)。設計書 §4。

検出器を替えても、出力・表示はこの形だけを見る。版(@1)は後方互換を保つ。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

SCHEMA = "chapterlens/segments@1"
TITLE_BY = ("llm", "rule", "user")
STATUS = ("committed", "tentative")


@dataclass
class Segment:
    start_s: float
    end_s: float
    title: str = ""
    title_by: str = "rule"
    confidence: float | None = None
    status: str = "committed"
    evidence: dict = field(default_factory=dict)

    def validate(self) -> None:
        if not (self.start_s >= 0 and self.end_s > self.start_s):
            raise ValueError(f"区間の時刻が不正です: {self.start_s}..{self.end_s}")
        if self.title_by not in TITLE_BY:
            raise ValueError(f"title_by が不正です: {self.title_by}")
        if self.status not in STATUS:
            raise ValueError(f"status が不正です: {self.status}")
        if self.confidence is not None and not (0.0 <= self.confidence <= 1.0):
            raise ValueError(f"confidence は 0〜1 です: {self.confidence}")


def segments_from_boundaries(
    boundaries: list[float],
    duration_s: float,
    *,
    detector: str,
    scores: list[float] | None = None,
) -> list[Segment]:
    """境界(区間の切れ目)の時刻の列から、先頭 0 秒〜末尾 duration_s の区間を作る。"""
    use_scores = scores is not None and len(scores) == len(boundaries)
    pairs = sorted(
        (b, (scores[i] if use_scores else None))
        for i, b in enumerate(boundaries)
        if 0.0 < b < duration_s
    )
    edges = [0.0, *(b for b, _ in pairs), duration_s]
    segments: list[Segment] = []
    for i in range(len(edges) - 1):
        # 区間の信頼度 = その区間の「始まりの境界」の信頼度(先頭の区間は無し)
        conf = pairs[i - 1][1] if i > 0 else None
        segments.append(
            Segment(
                start_s=round(edges[i], 3),
                end_s=round(edges[i + 1], 3),
                confidence=None if conf is None else round(max(0.0, min(1.0, conf)), 3),
                evidence={"detector": detector},
            )
        )
    return segments


def to_document(
    source: dict,
    segments: list[Segment],
    *,
    engine: str,
    asr: str | None = None,
) -> dict:
    for seg in segments:
        seg.validate()
    return {
        "schema": SCHEMA,
        "source": source,
        "segments": [
            {
                "start_s": s.start_s,
                "end_s": s.end_s,
                "title": s.title,
                "title_by": s.title_by,
                "confidence": s.confidence,
                "status": s.status,
                "evidence": s.evidence,
            }
            for s in segments
        ],
        "provenance": {
            "engine": engine,
            "asr": asr,
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    }


def from_document(doc: dict) -> list[Segment]:
    if doc.get("schema") != SCHEMA:
        raise ValueError(f"対応していない版です: {doc.get('schema')!r}(対応: {SCHEMA})")
    segments = [
        Segment(
            start_s=float(d["start_s"]),
            end_s=float(d["end_s"]),
            title=d.get("title", ""),
            title_by=d.get("title_by", "rule"),
            confidence=d.get("confidence"),
            status=d.get("status", "committed"),
            evidence=d.get("evidence") or {},
        )
        for d in doc.get("segments", [])
    ]
    for seg in segments:
        seg.validate()
    return segments
