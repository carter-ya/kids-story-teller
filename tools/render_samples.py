"""Render web/samples.js using the installed macOS enhanced Mandarin voices.

From the project root run: python3 tools/render_samples.py
Requires Python 3.12+, /usr/bin/swift, afconvert, and both voice IDs below.
All temporary masters and intermediate segments stay under the system temp directory.
"""
import array
import math
from pathlib import Path
import re
import statistics
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
SWIFT = ROOT / 'tools/narrate-utterance.swift'
VOICES = {
    'fox': 'com.apple.siri.natural.Linfei',
    'rabbit': 'com.apple.siri.natural.Linfei',
    'bear': 'com.apple.ttsbundle.gryphon-neural_zh-CN-D_zh-CN_premium',
}
# Only split at natural changes of speaker or a deliberate dramatic beat.
BREAKS = {
    'fox': ['说：“', '呢！”', '圆圆的字：', '晚安。'],
    'rabbit': ['小声问：'],
    'bear': ['轻轻一推：'],
}
RATE = 48_000
WINDOW = RATE // 100


def run(*arguments):
    subprocess.run(arguments, check=True, stdout=subprocess.DEVNULL)


def read_pcm(path):
    with wave.open(str(path), 'rb') as stream:
        actual = (stream.getframerate(), stream.getnchannels(), stream.getsampwidth())
        if actual != (RATE, 1, 2):
            raise ValueError(f'Unexpected PCM format {actual} in {path}')
        return array.array('h', stream.readframes(stream.getnframes()))


def envelope(data):
    levels = []
    for offset in range(0, len(data), WINDOW):
        samples = data[offset:offset + WINDOW]
        levels.append(math.sqrt(sum(x * x for x in samples) / len(samples)))
    return levels


def trim(data):
    active = [i for i, level in enumerate(envelope(data)) if level > 95]
    if not active:
        raise ValueError('Voice rendered a silent passage')
    start = max(0, (active[0] - 3) * WINDOW)
    end = min(len(data), (active[-1] + 4) * WINDOW)
    trimmed = data[start:end]
    fade_samples = RATE // 200
    for index in range(min(fade_samples, len(trimmed) // 2)):
        factor = index / fade_samples
        trimmed[index] = round(trimmed[index] * factor)
        trimmed[-index - 1] = round(trimmed[-index - 1] * factor)
    return trimmed


def phrasing(slug, title, text):
    yield title, .44, 1.0, .68
    paragraphs = text.split('\n\n')
    for index, paragraph in enumerate(paragraphs):
        closing = index == len(paragraphs) - 1
        cuts = {0, len(paragraph)}
        for marker in BREAKS[slug]:
            offset = paragraph.find(marker)
            if offset >= 0:
                cuts.add(offset + len(marker.rstrip('“')))
        edges = sorted(cuts)
        for start, end in zip(edges, edges[1:]):
            phrase = paragraph[start:end]
            if phrase == '晚安。':
                rate, pitch = .414, .985
            elif phrase.startswith('“'):
                rate, pitch = .465, 1.035
            elif closing:
                rate, pitch = .435, .98
            else:
                rate, pitch = .475, 1.0
            pause = .19
            if end == len(paragraph):
                pause = .30 if closing else .49
            yield phrase, rate, pitch, pause


def voiced_rms(levels):
    return math.sqrt(statistics.mean(value * value for value in levels if value > 250))


def render_sample(slug, title, text, work):
    track = array.array('h', [0]) * round(RATE * .1)
    phrases = list(phrasing(slug, title, text))
    if ''.join(phrase[0] for phrase in phrases[1:]) != text.replace('\n\n', ''):
        raise ValueError(f'Text alignment failed for {title}')
    for i, (phrase, rate, pitch, pause) in enumerate(phrases):
        stem = work / f'{slug}-{i}'
        caf = stem.with_suffix('.caf')
        wav = stem.with_suffix('.wav')
        run('/usr/bin/swift', '-module-cache-path', work / 'module-cache',
            SWIFT, VOICES[slug], phrase, str(rate), str(pitch), caf)
        run('afconvert', '-f', 'WAVE', '-d', 'LEI16', caf, wav)
        track.extend(trim(read_pcm(wav)))
        track.extend(array.array('h', [0]) * round(RATE * pause))

    speech_rms = voiced_rms(envelope(track))
    peak = max(map(abs, track))
    gain = min(32767 * 10 ** (-19 / 20) / speech_rms,
               32767 * 10 ** (-2.5 / 20) / peak)
    for i, value in enumerate(track):
        track[i] = round(value * gain)
    master = work / f'{slug}-master.wav'
    with wave.open(str(master), 'wb') as stream:
        stream.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        stream.writeframes(track.tobytes())

    target = work / f'{slug}.m4a'
    decoded = work / f'{slug}-decoded.wav'
    run('afconvert', '-f', 'm4af', '-d', 'aac', '-b', '96000', master, target)
    run('afconvert', '-f', 'WAVE', '-d', 'LEI16', target, decoded)
    data = read_pcm(decoded)
    profile = envelope(data)
    peak = max(map(abs, data))
    longest = current = 0
    for level in profile:
        current = current + 1 if level < 95 else 0
        longest = max(longest, current)
    rms_db = 20 * math.log10(voiced_rms(profile) / 32767)
    if longest > 140 or peak >= 32766 or abs(rms_db + 19) >= 4:
        raise ValueError(f'{title} failed QC: quiet={longest / 100}s, peak={peak}, RMS={rms_db}')
    duration = len(data) / RATE
    peak_db = 20 * math.log10(peak / 32767)
    print(f'{slug}: {duration:.3f}s, peak {peak_db:.1f} dBFS, '
          f'voiced RMS {rms_db:.1f} dBFS, max quiet {longest / 100:.2f}s', flush=True)
    return target, duration


def main():
    source = ROOT / 'web/samples.js'
    metadata = source.read_text()
    samples = re.findall(
        r'id: "(\w+)",\s*title: "([^"]+)",\s*theme: "[^"]+",\s*text: `([^`]+)`',
        metadata,
    )
    if {slug for slug, _, _ in samples} != set(VOICES):
        raise ValueError('Update voice assignments for the stories in web/samples.js')
    with tempfile.TemporaryDirectory(prefix='story-narration-') as temp:
        rendered = []
        for slug, title, text in samples:
            audio, duration = render_sample(slug, title, text, Path(temp))
            rendered.append((slug, audio))
            pattern = rf'(id: "{slug}",[\s\S]*?duration: )[\d.]+'
            metadata, count = re.subn(pattern, rf'\g<1>{duration:.3f}', metadata, count=1)
            if count != 1:
                raise ValueError(f'Missing duration field for {slug}')
        for slug, audio in rendered:
            (ROOT / 'web/assets' / f'{slug}.m4a').write_bytes(audio.read_bytes())
        source.write_text(metadata)


if __name__ == '__main__':
    main()
