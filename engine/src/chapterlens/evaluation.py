"""評価ハーネス(CH0)。正解(投稿者のチャプター)と、検出器・基準を同じ物差しで比べる。

評価データの置き方(動画 1 本 = 1 フォルダ。動画・音声そのものは置かない):

    dataset/<id>/meta.json        {"id": "...", "language": "ja", "duration_s": 3612.4, "title": "..."}
    dataset/<id>/captions.vtt     字幕(.vtt / .srt / .json3 のどれか)
    dataset/<id>/chapters.json    {"chapters": [{"start_s": 0, "title": "導入"}, ...]}
    または description.txt        概要欄の本文(「0:00 導入」の行を読む)

比べる系(system):
    fixed-300       300 秒ごと(字幕を見ない)
    uniform-k       正解と同じ区間数で等間隔
    <検出器>        検出器の既定の感度
    <検出器>+k      正解の区間数に合わせた感度(粒度を揃えて比べる。設計書 §7。製品では使えない上限の目安)
    <検出器>+prior  区間数を「動画の長さ ÷ 220 秒」で見積もる(製品で使える「標準の粒度」)
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

from . import baselines
from .captions import Cue, parse_captions
from .chapters import boundaries_from_chapters, parse_description_chapters
from .detectors import get_detector
from .metrics import (
    DEFAULT_TOLERANCES,
    BoundaryScore,
    aggregate,
    count_ratio,
    score_boundaries,
)

CAPTION_NAMES = ("captions.vtt", "captions.srt", "captions.json3")
MIN_REF_BOUNDARIES = 2  # 正解の境界が 2 つ未満(チャプター 3 つ未満)の動画は評価に使わない


class DatasetError(Exception):
    pass


def load_video(folder: Path) -> dict:
    """1 本ぶんを読む。使えなければ DatasetError(理由つき)。"""
    meta_path = folder / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    vid = meta.get("id") or folder.name

    cap_path = next((folder / n for n in CAPTION_NAMES if (folder / n).exists()), None)
    if cap_path is None:
        raise DatasetError(f"{vid}: 字幕(captions.vtt / .srt / .json3)がありません")
    cues = parse_captions(cap_path)
    if not cues:
        raise DatasetError(f"{vid}: 字幕が空です")

    chapters_json = folder / "chapters.json"
    description = folder / "description.txt"
    if chapters_json.exists():
        raw = json.loads(chapters_json.read_text(encoding="utf-8")).get("chapters", [])
        chapters = [(float(c["start_s"]), c.get("title", "")) for c in raw]
        chapters.sort()
    elif description.exists():
        chapters = parse_description_chapters(description.read_text(encoding="utf-8"))
    else:
        raise DatasetError(f"{vid}: 正解(chapters.json か description.txt)がありません")
    ref = boundaries_from_chapters(chapters)
    if len(ref) < MIN_REF_BOUNDARIES:
        raise DatasetError(f"{vid}: チャプターが 3 つ未満です(正解として使えません)")

    duration = float(meta.get("duration_s") or max(c.end_s for c in cues))
    return {
        "id": vid,
        "language": meta.get("language", "unknown"),
        "duration_s": duration,
        "cues": cues,
        "ref": ref,
    }


def load_dataset(root: Path) -> tuple[list[dict], list[str]]:
    videos: list[dict] = []
    skipped: list[str] = []
    for folder in sorted(p for p in Path(root).iterdir() if p.is_dir()):
        try:
            videos.append(load_video(folder))
        except DatasetError as e:
            skipped.append(str(e))
    return videos, skipped


PRIOR_SEGMENT_S = 220.0  # 1 区間の長さの目安(調整用 10 本の中央値)。「標準」の粒度。区間数 = 動画の長さ ÷ これ - 1


def _predictions(
    video: dict, detector_names: list[str], fixed_every_s: float, prior_segment_s: float = PRIOR_SEGMENT_S
) -> dict[str, list[float]]:
    duration, ref, cues = video["duration_s"], video["ref"], video["cues"]
    preds: dict[str, list[float]] = {
        f"fixed-{int(fixed_every_s)}": baselines.fixed_interval(duration, fixed_every_s),
        "uniform-k": baselines.uniform_k(duration, len(ref)),
    }
    for name in detector_names:
        det = get_detector(name)
        preds[name] = det.detect(cues, duration).boundaries
        preds[f"{name}+k"] = det.detect(cues, duration, target_count=len(ref)).boundaries
        k_prior = max(0, round(duration / prior_segment_s) - 1)
        preds[f"{name}+prior"] = det.detect(cues, duration, target_count=k_prior).boundaries
    return preds


def evaluate(
    videos: list[dict],
    detector_names: list[str],
    *,
    tolerances: tuple[float, ...] = DEFAULT_TOLERANCES,
    fixed_every_s: float = 300.0,
) -> dict:
    per_video = []
    scores: dict[str, dict[float, list[tuple[str, BoundaryScore]]]] = {}
    ratios: dict[str, list[float]] = {}
    for video in videos:
        preds = _predictions(video, detector_names, fixed_every_s)
        row = {
            "id": video["id"],
            "language": video["language"],
            "duration_s": video["duration_s"],
            "n_ref": len(video["ref"]),
            "systems": {},
        }
        for system, pred in preds.items():
            entry = {"n_pred": len(pred)}
            for tol in tolerances:
                s = score_boundaries(pred, video["ref"], tol)
                entry[f"f1@{tol:g}"] = round(s.f1, 4)
                scores.setdefault(system, {}).setdefault(tol, []).append((video["language"], s))
            r = count_ratio(pred, video["ref"])
            if r is not None:
                ratios.setdefault(system, []).append(r)
            row["systems"][system] = entry
        per_video.append(row)

    summary: dict[str, dict] = {}
    by_language: dict[str, dict[str, dict]] = {}
    for system, by_tol in scores.items():
        summary[system] = {
            "count_ratio_median": statistics.median(ratios[system]) if ratios.get(system) else None,
            "tolerances": {f"{tol:g}": aggregate([s for _, s in items]) for tol, items in by_tol.items()},
        }
        for tol, items in by_tol.items():
            for lang in sorted({lang for lang, _ in items}):
                by_language.setdefault(lang, {}).setdefault(system, {})[f"{tol:g}"] = aggregate(
                    [s for l, s in items if l == lang]
                )
    return {
        "videos": len(videos),
        "tolerances": [f"{t:g}" for t in tolerances],
        "per_video": per_video,
        "summary": summary,
        "by_language": by_language,
        "verdict": verdict(summary, detector_names, fixed_every_s, f"{max(tolerances):g}"),
    }


def verdict(summary: dict, detector_names: list[str], fixed_every_s: float, tol_key: str) -> dict:
    """設計書 §0 の R2 ④: 検出器が基準を**確実に上回る**か。

    - 同じ区間数のとき(<検出器>+k) vs uniform-k
    - 既定の感度のとき(<検出器>)   vs fixed-N
    許容が広い(±10 秒)ほうの macro F1 で比べる。
    """
    if not summary:
        return {"tolerance_s": tol_key, "checks": []}
    f1 = lambda system: summary[system]["tolerances"][tol_key]["macro_f1"]  # noqa: E731
    fixed = f"fixed-{int(fixed_every_s)}"
    checks = []
    for name in detector_names:
        checks.append(
            {
                "detector": name,
                "matched_count": {
                    "system": f"{name}+k",
                    "baseline": "uniform-k",
                    "f1": f1(f"{name}+k"),
                    "baseline_f1": f1("uniform-k"),
                    "margin": f1(f"{name}+k") - f1("uniform-k"),
                    "passes": f1(f"{name}+k") > f1("uniform-k"),
                },
                "default": {
                    "system": name,
                    "baseline": fixed,
                    "f1": f1(name),
                    "baseline_f1": f1(fixed),
                    "margin": f1(name) - f1(fixed),
                    "passes": f1(name) > f1(fixed),
                },
            }
        )
    return {"tolerance_s": tol_key, "checks": checks}


def _fmt(v: float | None, digits: int = 3) -> str:
    return "-" if v is None else f"{v:.{digits}f}"


def render_markdown(result: dict, skipped: list[str] | None = None) -> str:
    tols = result["tolerances"]
    lo, hi = tols[0], tols[-1]
    lines = [f"# ChapterLens 評価結果({result['videos']} 本)", ""]
    header = [
        "系",
        f"F1 ±{lo}s(macro)",
        f"F1 ±{hi}s(macro)",
        f"適合率 ±{hi}s",
        f"再現率 ±{hi}s",
        "ずれ 中央値(s)",
        "ずれ 90%(s)",
        "ずれの偏り(s)",
        "区間数の比(中央値)",
    ]
    lines += ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for system, s in result["summary"].items():
        a_lo, a_hi = s["tolerances"][lo], s["tolerances"][hi]
        off = a_hi["offset"]
        lines.append(
            "| "
            + " | ".join(
                [
                    system,
                    _fmt(a_lo["macro_f1"]),
                    _fmt(a_hi["macro_f1"]),
                    _fmt(a_hi["micro_precision"]),
                    _fmt(a_hi["micro_recall"]),
                    _fmt(off["abs_median"], 2),
                    _fmt(off["abs_p90"], 2),
                    _fmt(off["bias"], 2),
                    _fmt(s["count_ratio_median"], 2),
                ]
            )
            + " |"
        )
    lines += ["", f"## 基準との比較(±{result['verdict']['tolerance_s']}s・macro F1)", ""]
    lines += ["| 検出器 | 条件 | 検出器 | 基準 | 差 | 判定 |", "|---|---|---:|---:|---:|---|"]
    for c in result["verdict"]["checks"]:
        for key, label in (("matched_count", "同じ区間数"), ("default", "既定の感度")):
            v = c[key]
            lines.append(
                f"| {c['detector']} | {label}({v['system']} vs {v['baseline']}) | {_fmt(v['f1'])} | "
                f"{_fmt(v['baseline_f1'])} | {v['margin']:+.3f} | {'基準を上回る' if v['passes'] else '**上回らない**'} |"
            )
    if skipped:
        lines += ["", "## 評価に使えなかった動画", ""] + [f"- {s}" for s in skipped]
    return "\n".join(lines) + "\n"
