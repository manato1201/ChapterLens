"""題名・大見出しの検証と整形(純粋関数)。LLM が作った文を「字幕に実在するか」で機械的に確かめる。"""

from chapterlens.titles import check_sections, check_title, clean_title, parse_json_object, sample_text


def test_check_title_accepts_number_present_in_source():
    assert check_title("魚を売る(6220ベル)", "魚を売って 6,220 ベルになりました") is None


def test_check_title_rejects_invented_number():
    assert check_title("魚を売る(9999ベル)", "魚を売って 6,220 ベルになりました") is not None


def test_check_title_normalizes_fullwidth_digits():
    assert check_title("家のローン(98000ベル)", "ローンは９８０００ベルです") is None


def test_check_title_rejects_invented_katakana_name():
    assert check_title("タヌポートで買い物", "たぬポートで買い物をします") is not None


def test_check_title_accepts_katakana_present_in_source():
    assert check_title("タヌポートで買い物", "タヌポートで買い物をします") is None


def test_check_title_latin_is_case_insensitive():
    assert check_title("Minecraft を始める", "minecraft を始めます") is None
    assert check_title("Fortnite を始める", "minecraft を始めます") is not None


def test_check_title_rejects_too_short():
    assert check_title("短い", "短い") is not None


def test_check_title_rejects_too_long():
    assert check_title("あ" * 25, "あ" * 25) is not None


def test_check_title_rejects_newline():
    assert check_title("釣りを始める\n続き", "釣りを始める") is not None


def test_check_title_accepts_boundary_lengths():
    assert check_title("あ" * 8, "あ" * 8) is None
    assert check_title("あ" * 24, "あ" * 24) is None


def test_sample_text_short_is_unchanged_except_whitespace():
    assert sample_text("こんにちは   世界\n続き") == "こんにちは 世界 続き"


def test_sample_text_bounds_and_keeps_ends():
    t = "A" * 3000 + "MID" + "B" * 3000
    s = sample_text(t, 4000)
    assert len(s) <= 4000
    assert s.startswith("A") and s.endswith("B")


def test_sample_text_includes_the_middle():
    t = "A" * 5000 + "MIDDLE" + "B" * 5000
    assert "MIDDLE" in sample_text(t, 4000)


def test_clean_title_strips_decoration():
    assert clean_title('  「魚を売る(6220ベル)」\n説明です') == "魚を売る(6220ベル)"
    assert clean_title("題名: 釣りを始める") == "釣りを始める"
    assert clean_title("- 釣りを始める") == "釣りを始める"
    assert clean_title("1. 釣りを始める") == "釣りを始める"


def test_check_sections_accepts_contiguous():
    ok = [{"heading": "釣り", "from": 0, "to": 2}, {"heading": "買い物", "from": 3, "to": 4}]
    assert check_sections(ok, 5) == ok


def test_check_sections_rejects_gap():
    bad = [{"heading": "釣り", "from": 0, "to": 2}, {"heading": "買い物", "from": 4, "to": 4}]
    assert check_sections(bad, 5) is None


def test_check_sections_rejects_overlap_and_wrong_start_end():
    assert check_sections([{"heading": "a", "from": 0, "to": 2}, {"heading": "b", "from": 2, "to": 4}], 5) is None
    assert check_sections([{"heading": "a", "from": 1, "to": 2}, {"heading": "b", "from": 3, "to": 4}], 5) is None
    assert check_sections([{"heading": "a", "from": 0, "to": 2}, {"heading": "b", "from": 3, "to": 3}], 5) is None


def test_check_sections_rejects_single_section():
    assert check_sections([{"heading": "全部", "from": 0, "to": 4}], 5) is None


def test_check_sections_rejects_bad_heading_and_types():
    assert check_sections([{"heading": "", "from": 0, "to": 2}, {"heading": "b", "from": 3, "to": 4}], 5) is None
    assert check_sections([{"heading": "あ" * 17, "from": 0, "to": 2}, {"heading": "b", "from": 3, "to": 4}], 5) is None
    assert check_sections([{"heading": "a\nb", "from": 0, "to": 2}, {"heading": "b", "from": 3, "to": 4}], 5) is None
    assert check_sections("not a list", 5) is None
    assert check_sections([{"heading": "a", "from": "0", "to": 2}, {"heading": "b", "from": 3, "to": 4}], 5) is None
    assert check_sections([], 5) is None


def test_parse_json_object_handles_fences_and_prose():
    assert parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_object('結果です: [{"x": 1}] 以上') == [{"x": 1}]
    assert parse_json_object("よろしくお願いします") is None
    assert parse_json_object("") is None


# ---- 最終レビューの指摘(I1・I2) ----
def test_check_title_number_must_match_a_whole_number_in_source():
    assert check_title("魚を売る(220ベル)の場面", "魚を売って6220ベルになった") is not None  # 部分文字列では通さない
    assert check_title("魚を売る(6220ベル)の場面", "魚を売って6220ベルになった") is None
    assert check_title("魚を 1234 匹釣る話をする", "魚を 12 34 匹釣った話") is not None  # 離れた数字をつなげない
    assert check_title("魚を 6220 匹釣る話をする", "魚を 6,220 匹釣った話") is None  # 桁区切りは同じ数


def test_clean_title_strips_thinking_block():
    assert clean_title("<think>うーん、どうしよう</think>\n魚を売って稼ぐ(6220ベル)") == "魚を売って稼ぐ(6220ベル)"
    assert clean_title("<think>考えている途中で、出力が切れた") == ""


def test_parse_json_object_ignores_thinking_block():
    assert parse_json_object('<think>[1, 2]</think>\n[{"heading": "a", "from": 0, "to": 1}]') == [{"heading": "a", "from": 0, "to": 1}]
