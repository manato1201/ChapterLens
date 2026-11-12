"""検出器の口(設計書 §5)。入力は字幕の列、出力は境界の時刻と信頼度。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol

from ..captions import Cue


@dataclass
class Detection:
    boundaries: list[float]  # 区間の切れ目(秒・昇順。先頭の 0 秒は含めない)
    scores: list[float]  # 各境界の信頼度(0〜1)。boundaries と同じ長さ
    detector: str
    params: dict = field(default_factory=dict)


class Detector(Protocol):
    name: str

    def detect(
        self,
        cues: list[Cue],
        duration_s: float,
        *,
        target_count: int | None = None,
    ) -> Detection: ...


_REGISTRY: dict[str, Callable[[], Detector]] = {}


def register(name: str, factory: Callable[[], Detector]) -> None:
    _REGISTRY[name] = factory


def get_detector(name: str) -> Detector:
    if name not in _REGISTRY:
        raise KeyError(f"検出器がありません: {name}(あるもの: {', '.join(sorted(_REGISTRY))})")
    return _REGISTRY[name]()


def available() -> list[str]:
    return sorted(_REGISTRY)
