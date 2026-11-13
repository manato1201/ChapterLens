# 第 8 回 音の基礎と、タブの音を文字にするまで

> 所要時間の目安: 4 時間 / 前提: 第 7 回

## この回のゴール

- 音が**数の列(PCM)**になる仕組みと、**サンプリング周波数**の意味が分かる。
- **ダウンサンプル**・**WAV**・**チャンク**(30 秒の区切り)が、なぜ必要かを説明できる。
- 「**時計の時刻**」と「**動画の再生位置**」が違うことと、`TimeMap` の役割を説明できる。
- 音声認識(ASR)の出力(単語ごとの時刻)から、境界を**発話の頭**に寄せる方法が分かる。

## 1. 音は数の列

音は空気の振動です。マイクは、これを**一定の間隔で測って**、数の列にします。

- **サンプリング周波数**: 1 秒に何回測るか。ブラウザの音は **48000 Hz**(1 秒に 48000 個)が多い。
- 1 つの数を**サンプル**と呼び、-1〜+1 の小数(`float32`)で持つ。これが **PCM**(波形そのまま)。
- 1 秒・モノラル・48 kHz なら、48000 個。**重い**(30 秒で 144 万個)。

```python
# 実行できる
import math

rate = 16000                       # 1 秒に 16000 回測る
freq = 440.0                       # ラの音(1 秒に 440 回振動)
samples = [math.sin(2 * math.pi * freq * n / rate) for n in range(rate)]
print("サンプル数:", len(samples), "= 1 秒 ×", rate, "Hz")
print("最初の 5 つ:", [round(x, 3) for x in samples[:5]])
rms = math.sqrt(sum(x * x for x in samples) / len(samples))
print("音の大きさ(RMS):", round(rms, 3), "(正弦波は 0.707 になる)")
```

```text
# 出力
サンプル数: 16000 = 1 秒 × 16000 Hz
最初の 5 つ: [0.0, 0.172, 0.339, 0.495, 0.637]
音の大きさ(RMS): 0.707 (正弦波は 0.707 になる)
```

**RMS**(二乗平均平方根)は、音の大きさの目安です。無音に近いかを調べるのに使います(`rms` 関数)。

## 2. 16 kHz にする(ダウンサンプル)

音声認識(Whisper)は **16 kHz・モノラル**で学習されています。48 kHz のまま送ると、データが 3 倍重いだけで、認識には役に立ちません。
そこで、**3 つの入力を 1 つの出力に平均**して、16 kHz にします(拡張の `Downsampler`)。

```python
# 実行できる
# 割り切れる比(48k → 16k = 3 : 1): 3 サンプルずつ平均する
inp = [0.0, 0.3, 0.6, 0.9, 0.6, 0.3]
ratio = 3
out = [sum(inp[i:i + ratio]) / ratio for i in range(0, len(inp), ratio)]
print([round(x, 2) for x in out])
```

```text
# 出力
[0.3, 0.6]
```

```javascript
// 抜粋ファイル: extension/src/capture.js
  class Downsampler {
    constructor(inRate, outRate = TARGET_RATE) {
      this.ratio = inRate / outRate;
    process(input) {
```

実際の `Downsampler` は、44.1 kHz のように**割り切れない比**(2.75 : 1)でも、**位置ベースの平均**(境界をまたぐサンプルは、重みをつけて両方に配る)で扱えます。

## 3. WAV にする

エンジンへ送る形式は **WAV**(16 kHz・16 bit・モノラル)。ファイルの先頭に **44 バイトのヘッダ**が付き、そのあとに PCM が続きます。

```python
# 実行できる
import io, struct, wave

rate = 16000
pcm = [int(32767 * 0.5)] * 160     # 0.01 秒ぶん(16 ビットの整数)
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes(struct.pack("<" + "h" * len(pcm), *pcm))
data = buf.getvalue()
print("全体:", len(data), "バイト = ヘッダ 44 + 音 ", 160 * 2)
print("先頭 4 文字:", data[:4], " 8〜12 文字:", data[8:12])
print("サンプリング周波数(24〜28 バイト目):", struct.unpack("<I", data[24:28])[0])
```

```text
# 出力
全体: 364 バイト = ヘッダ 44 + 音  320
先頭 4 文字: b'RIFF'  8〜12 文字: b'WAVE'
サンプリング周波数(24〜28 バイト目): 16000
```

JavaScript の `encodeWav` は、これと同じ 44 バイトを `DataView` で書いています(`RIFF`・`WAVE`・`fmt `・`data`)。
エンジン側は、16 kHz・16 bit・モノラルの WAV なら**標準ライブラリだけ**で読み(`decode_audio`)、それ以外は ffmpeg に任せます。

```python
# 引用: engine/src/chapterlens/asr.py::decode_audio
def decode_audio(path: str | Path, sample_rate: int = 16000):
    """音声ファイル → 16kHz・モノラルの float32 配列(numpy)。

    16kHz・16bit・モノラルの WAV は標準ライブラリだけで読む。それ以外(webm/opus・mp3 など)は ffmpeg で読む。
    PyAV の版に依存しない(faster-whisper の組み込みのデコードは、PyAV の版で壊れることがある)。
    """
    import numpy as np

    path = Path(path)
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as w:
                if w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == sample_rate:
                    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        except wave.Error:
            pass
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise AsrUnavailable("ffmpeg が見つかりません(WAV 以外の音声を読むのに必要です)")
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(sample_rate), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise AsrUnavailable(f"音声を読めませんでした: {proc.stderr.decode('utf-8', 'replace')[:200]}")
    return np.frombuffer(proc.stdout, dtype=np.float32)
```

## 4. 30 秒に区切る(チャンク)

再生は何時間も続きます。**全部溜めてから送る**と、いつまでも結果が出ません。そこで **30 秒ごと**に区切って送り、結果を順に足します(`Chunker`)。

- 一時停止中は音が来ない。そのまま詰めると、**時刻がずれていく**。だから、飛んだ時間を**無音で埋めて**、チャンクの時刻を保ちます。
- 1 秒に満たない端は捨てます。
- 音がほとんど無い(RMS が小さい)チャンクは、**送らずに飛ばします**(エンジンの負荷を減らす)。

```javascript
// 抜粋ファイル: extension/src/capture.js
  class Chunker {
    push(streamTimeS, samples) {
      // 時刻が飛んでいたら(停止中は音が来ない)、その分を無音で埋める。ずれを溜めない
      const gapSamples = Math.round((streamTimeS - this.nextS) * this.rate);
```

## 5. 時計と再生位置は別物

エンジンが返す字幕の時刻は、**そのチャンクの先頭からの秒**です。しかし、目次に要るのは、**動画の再生位置**です。
両者は一致しません。

- 一時停止すれば、時計は進むが、動画は進まない。
- **シーク**すれば、動画の位置が飛ぶ。**倍速**にすれば、進み方が変わる。

そこで、`TimeMap` が、**(時計の時刻, 動画の位置)の点の列**を記録し、間を線形に補います。

```python
# 実行できる
# TimeMap の考え方(JavaScript 版 capture.js の簡略化): 点の間を線形補間する
points = [(0, 0.0), (10_000, 10.0), (20_000, 10.0), (30_000, 20.0)]   # (時計 ms, 動画 秒)。10〜20 秒は一時停止

def media_at(wall_ms):
    for (w0, m0), (w1, m1) in zip(points, points[1:]):
        if wall_ms <= w1:
            return m0 + (m1 - m0) * (wall_ms - w0) / (w1 - w0)
    return points[-1][1]

for wall in (5_000, 10_000, 15_000, 25_000):
    print(f"時計 {wall // 1000:2d} 秒 → 動画 {media_at(wall):.1f} 秒")
```

```text
# 出力
時計  5 秒 → 動画 5.0 秒
時計 10 秒 → 動画 10.0 秒
時計 15 秒 → 動画 10.0 秒
時計 25 秒 → 動画 15.0 秒
```

時計 15 秒は、停止中なので動画は 10.0 秒のまま。再生が再開した後(時計 25 秒)は、動画 15.0 秒。
`content.js` は、`timeupdate`・`pause`・`ratechange`・`seeking` のたびに点を足し、受け取った字幕を `shiftCues` で**動画の時刻**に直します。

## 6. 音声認識(ASR)

エンジンは **faster-whisper**(OpenAI の Whisper を高速化した実装)で、音を文字にします。

- **GPU**(RTX 3070)が使えれば `float16`、なければ CPU の `int8` に**自動で切り替える**(CUDA の DLL が無いなど、環境で失敗しても止まらない)。
- 出力は、文のかたまり(`cues`)と、**単語ごとの開始・終了時刻**(`words`)。
- `faster-whisper` は**任意の依存**(`uv sync --extra asr`)。無いときは、エンジンは `501` と説明を返し、字幕から作る機能は影響を受けません。

## 7. 境界を「発話の頭」に寄せる

話題の切り替えは、**誰かが話し始める所**で起きます。単語の時刻があれば、境界をその頭に合わせられます。

```python
# 引用: engine/src/chapterlens/asr.py::utterance_starts
def utterance_starts(words: list[Word], *, min_pause_s: float = 0.35) -> list[float]:
    """発話の頭になりうる時刻: 先頭の単語と、直前に min_pause_s 以上の間(無音)がある単語の開始。"""
    starts: list[float] = []
    prev_end = None
    for w in words:
        if prev_end is None or w.start_s - prev_end >= min_pause_s:
            starts.append(w.start_s)
        prev_end = w.end_s
    return starts
```
```python
# 引用: engine/src/chapterlens/asr.py::snap_to_utterances
def snap_to_utterances(
    boundaries: list[float], words: list[Word], *, radius_s: float = 5.0, min_pause_s: float = 0.35
) -> list[float]:
    """各境界を、近く(±radius_s)の「発話の頭」へ寄せる。近くに無ければ、最も近い単語の開始へ(±radius_s)。"""
    if not words:
        return list(boundaries)
    heads = utterance_starts(words, min_pause_s=min_pause_s)
    word_starts = [w.start_s for w in words]
    out: list[float] = []
    for b in boundaries:
        best = _nearest(heads, b, radius_s)
        if best is None:
            best = _nearest(word_starts, b, radius_s)
        out.append(best if best is not None else b)
    return out
```

```python
# 実行できる
from chapterlens.asr import Word, snap_to_utterances, utterance_starts

words = [Word(10.0, 10.4, "こんにちは"), Word(10.5, 11.0, "今日は"),     # 間 0.1 秒: 同じ発話
         Word(12.0, 12.5, "次の"), Word(12.6, 13.0, "話題"),            # 間 1.0 秒: 新しい発話の頭は 12.0
         Word(20.0, 20.4, "別の"), Word(20.5, 21.0, "話")]
print("発話の頭:", utterance_starts(words))
print("寄せる   :", snap_to_utterances([11.6, 19.2, 40.0], words))   # 近くに無い 40.0 はそのまま
```

```text
# 出力
発話の頭: [10.0, 12.0, 20.0]
寄せる   : [12.0, 20.0, 40.0]
```

ここで、実測の注意を 1 つ。**合成音声**(静かで明瞭)での、発話の始まりの時刻のずれは中央値 0.04〜0.12 秒でしたが、
**BGM・複数人・雑音**の入った本物の音での精度は**未測定**です(他人の音声を取得しない方針のため、自分の動画・許諾済みの素材が要る)。

## 確認問題

1. 16 kHz・モノラルで 30 秒の音は、何個のサンプルですか。16 bit で何バイトですか(ヘッダ除く)。
2. 一時停止の間、`Chunker` が無音を埋めるのはなぜですか。
3. 時計 25 秒が、動画の 15 秒に対応するとき、これは何を意味しますか(上の例)。
4. `faster-whisper` が入っていない環境で、字幕から目次を作る機能は動きますか。
5. 40.0 秒の境界が、`snap_to_utterances` でそのまま返ったのはなぜですか。

## 解答

1. 16000 × 30 = 480000 個。16 bit(2 バイト)なので 960000 バイト(約 940 KB)。
2. 音が来ない間も時計は進むので、そのままだと、以降のチャンクの時刻が実際より**早く**なり、ずれが溜まるから。
3. 10〜20 秒は一時停止していて、時計が 10 秒進む間、動画は進まなかった。再開後の 5 秒で、動画は 10 → 15 秒。
4. 動く。字幕から作る検出は拡張の中だけで完結し、エンジンも ASR も使わない。
5. 近く(±5 秒)に、発話の頭も単語の開始も無かったので、寄せる先が無く、元の値のまま。

## まとめ

- 音は数の列。16 kHz・モノラル・16 bit の WAV にして、30 秒ごとに送る。
- 時計の時刻と動画の再生位置は別物。`TimeMap` が、一時停止・シーク・倍速を吸収する。
- 認識の出力(単語の時刻)で、境界を発話の頭に寄せる。
- 重い依存(ASR)は**任意**にして、軽い機能(字幕から作る)を巻き込まない。
- 次の回は、エンジンの HTTP サーバーと、安全の設計。
