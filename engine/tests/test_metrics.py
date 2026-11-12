import pytest

from chapterlens import baselines
from chapterlens.metrics import (
    aggregate,
    count_ratio,
    match_boundaries,
    offset_stats,
    percentile,
    score_boundaries,
)


def test_perfect_match():
    s = score_boundaries([100, 200, 300], [100, 200, 300], 3)
    assert (s.precision, s.recall, s.f1) == (1.0, 1.0, 1.0)
    assert s.errors_s == [0, 0, 0]


def test_tolerance_is_inclusive_and_signed_error():
    s = score_boundaries([103.0], [100.0], 3.0)
    assert s.tp == 1 and s.errors_s == [3.0]
    assert score_boundaries([103.5], [100.0], 3.0).tp == 0


def test_extra_and_missing():
    s = score_boundaries([100, 150, 500], [100, 300], 3)
    assert s.tp == 1
    assert s.precision == pytest.approx(1 / 3)
    assert s.recall == pytest.approx(1 / 2)


def test_one_to_one_matching():
    # 予測 2 つが同じ正解 1 つの近くにあっても、当たりは 1 つだけ
    s = score_boundaries([99, 101], [100], 3)
    assert s.tp == 1 and s.n_pred == 2


def test_matching_is_maximum_on_a_line():
    # 貪欲法でも、順序を守れば最大の対応数になる(近い方を先に取り合わない)
    pairs = match_boundaries([10, 13], [12, 15], 3)
    assert len(pairs) == 2


def test_empty_cases():
    assert score_boundaries([], [], 3).f1 == 1.0
    assert score_boundaries([], [100], 3).f1 == 0.0
    assert score_boundaries([100], [], 3).f1 == 0.0


def test_offset_stats():
    st = offset_stats([1.0, -2.0, 3.0, -4.0])
    assert st["n"] == 4
    assert st["abs_median"] == pytest.approx(2.5)
    assert st["bias"] == pytest.approx(-0.5)
    assert offset_stats([])["abs_median"] is None


def test_percentile():
    assert percentile([1, 2, 3, 4, 5], 50) == 3
    assert percentile([1, 2, 3, 4, 5], 100) == 5
    assert percentile([], 50) is None


def test_count_ratio():
    assert count_ratio([1, 2, 3], [1, 2]) == 1.5
    assert count_ratio([1], []) is None


def test_aggregate_macro_vs_micro():
    a = score_boundaries([100], [100], 3)  # f1 1.0
    b = score_boundaries([], [100, 200, 300, 400], 3)  # f1 0.0
    agg = aggregate([a, b])
    assert agg["macro_f1"] == pytest.approx(0.5)
    assert agg["micro_recall"] == pytest.approx(1 / 5)


def test_baselines():
    assert baselines.uniform_k(100, 3) == [25, 50, 75]
    assert baselines.uniform_k(100, 0) == []
    # 600 秒を 300 秒ごと: 300 は末尾(600)から 300 > 150 離れているので置く
    assert baselines.fixed_interval(600, 300) == [300]
    # 末尾の直前(半分以内)には置かない
    assert baselines.fixed_interval(620, 300) == [300]
    assert baselines.fixed_interval(100, 300) == []
    with pytest.raises(ValueError):
        baselines.fixed_interval(100, 0)
