"""検出器。import すると登録される。"""

from . import topic_shift  # noqa: F401  (登録のため)
from .base import Detection, Detector, available, get_detector, register

__all__ = ["Detection", "Detector", "available", "get_detector", "register"]
