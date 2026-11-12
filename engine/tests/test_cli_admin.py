import json

from chapterlens.cli import main


def run(capsys, monkeypatch, tmp_path, *argv):
    monkeypatch.setenv("CHAPTERLENS_HOME", str(tmp_path))
    code = main(["admin", *argv])
    out = capsys.readouterr()
    return code, out.out, out.err


def test_add_list_disable_enable_rotate(capsys, monkeypatch, tmp_path):
    code, out, _ = run(capsys, monkeypatch, tmp_path, "add-user", "alice")
    assert code == 0 and "token" in out
    token = out.split(": ")[-1].strip()
    uid = out.split("作成: ")[1].split()[0]
    code, out, _ = run(capsys, monkeypatch, tmp_path, "users")
    assert "alice" in out and "local" in out and token not in out
    assert run(capsys, monkeypatch, tmp_path, "disable", uid)[0] == 0
    assert "停止中" in run(capsys, monkeypatch, tmp_path, "users")[1]
    assert run(capsys, monkeypatch, tmp_path, "enable", uid)[0] == 0
    code, out, _ = run(capsys, monkeypatch, tmp_path, "rotate", uid)
    assert code == 0 and out.split(": ")[-1].strip() != token

    from chapterlens.accounts import AccountStore

    a = AccountStore(tmp_path / "accounts.db")
    assert a.authenticate(token) is None  # 古い token は無効
    a.close()


def test_errors_and_protected_local(capsys, monkeypatch, tmp_path):
    code, _, err = run(capsys, monkeypatch, tmp_path, "disable", "local")
    assert code == 1 and "local" in err
    code, _, err = run(capsys, monkeypatch, tmp_path, "disable", "u_00000000")
    assert code == 1


def test_purge_requires_yes(capsys, monkeypatch, tmp_path):
    out = run(capsys, monkeypatch, tmp_path, "add-user", "bob")[1]
    uid = out.split("作成: ")[1].split()[0]
    code, out, _ = run(capsys, monkeypatch, tmp_path, "purge", uid)
    assert code == 1 and "--yes" in out
    assert "bob" in run(capsys, monkeypatch, tmp_path, "users")[1]
    assert run(capsys, monkeypatch, tmp_path, "purge", uid, "--yes")[0] == 0
    assert "bob" not in run(capsys, monkeypatch, tmp_path, "users")[1]


def test_share_mode_and_audit(capsys, monkeypatch, tmp_path):
    assert "off" in run(capsys, monkeypatch, tmp_path, "share-mode")[1]
    assert "team" in run(capsys, monkeypatch, tmp_path, "share-mode", "team")[1]
    assert "team" in run(capsys, monkeypatch, tmp_path, "share-mode")[1]
    run(capsys, monkeypatch, tmp_path, "add-user", "carol")
    lines = [
        json.loads(x)
        for x in run(capsys, monkeypatch, tmp_path, "audit", "-n", "10")[1].splitlines()
    ]
    assert [e["event"] for e in lines] == [
        "admin.settings.share_mode",
        "admin.user.create",
    ]
    assert all(e["actor"] == "cli" for e in lines)
    assert "token" not in json.dumps(lines)
