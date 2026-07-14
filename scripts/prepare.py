# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "ariautils @ git+https://github.com/EleutherAI/aria-utils.git@4ed0749d2d70918610f03a5316bf283479ff9d09",
# ]
# ///
"""Prepare aligned speech and piano timelines for the browser demo.

Run from the repository root with:

    uv run scripts/prepare.py

The source manifests' coarse piano classifications are intentionally ignored.
Speech activity is derived from caption word timing and piano activity from the
MIDI transcription. Displayed notes preserve the resolved raw MIDI intervals.
Only the copy used to build contiguous piano regions is duration-capped, so a
spurious long note cannot bridge an otherwise silent passage.
"""

from __future__ import annotations

import argparse
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ariautils.midi import MidiDict


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SAMPLES = ROOT / "samples"
DEFAULT_OUTPUT = ROOT / "src" / "data" / "dataset.json"

TIMESTAMP = r"(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}"
CUE_RE = re.compile(rf"^({TIMESTAMP})\s+-->\s+({TIMESTAMP})(?:\s+.*)?$")
INLINE_WORD_RE = re.compile(
    rf"<(?P<time>{TIMESTAMP})><c(?:\.[^>]*)?>(?P<text>.*?)</c>", re.DOTALL
)
TAG_RE = re.compile(r"<[^>]+>")
ANNOTATION_RE = re.compile(r"^\s*[\[(].*[\])]\s*$")


@dataclass(slots=True)
class CaptionToken:
    start: float
    end: float
    text: str


def parse_timestamp(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    if len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    else:
        hours, minutes, seconds = parts
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def clean_caption_text(value: str) -> str:
    value = html.unescape(TAG_RE.sub("", value)).replace("\u200b", " ")
    return re.sub(r"\s+", " ", value).strip()


def is_spoken_text(value: str) -> bool:
    return bool(value and not ANNOTATION_RE.match(value))


def read_vtt_cues(path: Path) -> list[tuple[float, float, str]]:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    cues: list[tuple[float, float, str]] = []
    index = 0
    while index < len(lines):
        match = CUE_RE.match(lines[index].strip())
        if not match:
            index += 1
            continue
        start, end = map(parse_timestamp, match.groups())
        index += 1
        content: list[str] = []
        # Some YouTube ASR exports put a whitespace-only line immediately
        # after the cue header. Use the next cue header—not a blank line—as
        # the boundary, and discard blank content lines along the way.
        while index < len(lines) and not CUE_RE.match(lines[index].strip()):
            if lines[index].strip():
                content.append(lines[index])
            index += 1
        cues.append((start, end, "\n".join(content)))
    return cues


def caption_tokens(path: Path) -> list[CaptionToken]:
    cues = read_vtt_cues(path)
    has_word_timing = any(INLINE_WORD_RE.search(content) for _, _, content in cues)
    tokens: list[CaptionToken] = []

    for cue_start, cue_end, content in cues:
        matches = list(INLINE_WORD_RE.finditer(content))
        if not matches:
            # YouTube's rolling ASR VTT includes short duplicate cues without
            # word timestamps. Ignore those when a word-timed track is present.
            if has_word_timing:
                continue
            text = clean_caption_text(content)
            if is_spoken_text(text):
                tokens.append(CaptionToken(cue_start, cue_end, text))
            continue

        # Text before the first timestamp contains rolling context on earlier
        # lines and the new leading word on its final line.
        prefix_lines = content[: matches[0].start()].splitlines()
        prefix = clean_caption_text(prefix_lines[-1]) if prefix_lines else ""
        first_time = parse_timestamp(matches[0].group("time"))
        if is_spoken_text(prefix):
            tokens.append(CaptionToken(cue_start, max(cue_start, first_time), prefix))

        for position, match in enumerate(matches):
            start = parse_timestamp(match.group("time"))
            end = (
                parse_timestamp(matches[position + 1].group("time"))
                if position + 1 < len(matches)
                else cue_end
            )
            text = clean_caption_text(match.group("text"))
            if is_spoken_text(text):
                tokens.append(CaptionToken(start, max(start, end), text))

    tokens.sort(key=lambda token: (token.start, token.end))
    deduplicated: list[CaptionToken] = []
    seen: set[tuple[int, str]] = set()
    for token in tokens:
        key = (round(token.start * 1000), token.text.casefold())
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(token)
    return deduplicated


def joined_text(parts: Iterable[str]) -> str:
    text = " ".join(parts)
    return re.sub(r"\s+([,.;:!?])", r"\1", text).strip()


def build_speech_segments(
    tokens: list[CaptionToken], silence_gap: float
) -> list[dict[str, Any]]:
    if not tokens:
        return []
    groups: list[list[CaptionToken]] = [[tokens[0]]]
    group_end = tokens[0].end
    for token in tokens[1:]:
        if token.start - group_end >= silence_gap:
            groups.append([token])
            group_end = token.end
        else:
            groups[-1].append(token)
            group_end = max(group_end, token.end)

    return [
        {
            "start": round(group[0].start, 3),
            "end": round(max(token.end for token in group), 3),
            "text": joined_text(token.text for token in group),
            "words": [
                {
                    "start": round(token.start, 3),
                    "end": round(token.end, 3),
                    "text": token.text,
                }
                for token in group
            ],
        }
        for group in groups
    ]


def read_midi(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, float]]]:
    """Read resolved key-down notes and sustain-pedal intervals with Aria."""
    midi = MidiDict.from_midi(path).resolve_overlaps()

    def seconds_at_tick(tick: int) -> float:
        return midi.tick_to_ms(tick) / 1000

    notes = [
        {
            "start": round(seconds_at_tick(message["data"]["start"]), 4),
            "end": round(seconds_at_tick(message["data"]["end"]), 4),
            "pitch": message["data"]["pitch"],
            "velocity": message["data"]["velocity"],
            "channel": message["channel"],
        }
        for message in midi.note_msgs
    ]
    notes.sort(key=lambda note: (note["start"], note["pitch"], note["end"]))

    pedal_down: dict[int, float] = {}
    pedal_intervals: list[tuple[float, float]] = []
    for message in sorted(midi.pedal_msgs, key=lambda item: item["tick"]):
        seconds = seconds_at_tick(message["tick"])
        channel = message["channel"]
        if message["data"] == 1 and channel not in pedal_down:
            pedal_down[channel] = seconds
        elif message["data"] == 0 and channel in pedal_down:
            pedal_intervals.append((pedal_down.pop(channel), seconds))

    final_seconds = max(
        [0.0]
        + [note["end"] for note in notes]
        + [seconds_at_tick(message["tick"]) for message in midi.pedal_msgs]
    )
    for start in pedal_down.values():
        pedal_intervals.append((start, final_seconds))

    pedal_intervals.sort()
    merged_pedal: list[list[float]] = []
    for start, end in pedal_intervals:
        if end <= start:
            continue
        if merged_pedal and start <= merged_pedal[-1][1]:
            merged_pedal[-1][1] = max(merged_pedal[-1][1], end)
        else:
            merged_pedal.append([start, end])
    pedal_segments = [
        {"start": round(start, 4), "end": round(end, 4)} for start, end in merged_pedal
    ]
    return notes, pedal_segments


def build_piano_segments(
    notes: list[dict[str, Any]],
    silence_gap: float,
    max_activity_note_duration: float,
) -> list[dict[str, Any]]:
    if not notes:
        return []
    segments: list[dict[str, Any]] = []
    start = notes[0]["start"]
    end = min(notes[0]["end"], start + max_activity_note_duration)
    note_count = 1
    for note in notes[1:]:
        note_end = min(note["end"], note["start"] + max_activity_note_duration)
        if note["start"] - end >= silence_gap:
            segments.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "noteCount": note_count,
                }
            )
            start, end, note_count = note["start"], note_end, 1
        else:
            end = max(end, note_end)
            note_count += 1
    segments.append(
        {"start": round(start, 3), "end": round(end, 3), "noteCount": note_count}
    )
    return segments


def prepare_sample(
    directory: Path,
    speech_silence_gap: float,
    piano_silence_gap: float,
    max_activity_note_duration: float,
) -> dict[str, Any]:
    manifest = json.loads((directory / "manifest.json").read_text())
    tokens = caption_tokens(directory / "captions.vtt")
    notes, pedal = read_midi(directory / "transcription.mid")
    speech = build_speech_segments(tokens, speech_silence_gap)
    piano = build_piano_segments(notes, piano_silence_gap, max_activity_note_duration)
    video = manifest.get("database", {}).get("video_crawl", {})
    duration = max(
        [0.0]
        + [segment["end"] for segment in speech]
        + [segment["end"] for segment in piano]
        + [segment["end"] for segment in pedal]
        + [note["end"] for note in notes]
    )
    sample_id = manifest.get("youtube_id", directory.name)
    return {
        "id": sample_id,
        "youtubeId": sample_id,
        "youtubeUrl": manifest.get(
            "youtube_url", f"https://www.youtube.com/watch?v={sample_id}"
        ),
        "title": video.get("title") or sample_id,
        "channel": video.get("channel_name") or "",
        "rationale": manifest.get("selection", {}).get("rationale", ""),
        "duration": round(duration, 3),
        "speechSegments": speech,
        "pianoSegments": piano,
        "pedalSegments": pedal,
        "notes": notes,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, default=DEFAULT_SAMPLES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--speech-silence-gap",
        type=float,
        default=2.0,
        help="A gap this long starts a new speech segment (default: 2.0).",
    )
    parser.add_argument(
        "--piano-silence-gap",
        type=float,
        default=1.0,
        help="A gap this long starts a new piano segment (default: 1.0).",
    )
    parser.add_argument(
        "--max-activity-note-duration",
        "--max-note-duration",
        dest="max_activity_note_duration",
        type=float,
        default=5.0,
        help=(
            "Cap note durations only while deriving contiguous piano activity "
            "regions (default: 5.0)."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sample_dirs = sorted(
        path for path in args.samples.iterdir() if (path / "manifest.json").is_file()
    )
    if (
        min(
            args.speech_silence_gap,
            args.piano_silence_gap,
            args.max_activity_note_duration,
        )
        <= 0
    ):
        raise SystemExit(
            "Silence gaps and maximum activity note duration must be positive."
        )
    samples = [
        prepare_sample(
            path,
            args.speech_silence_gap,
            args.piano_silence_gap,
            args.max_activity_note_duration,
        )
        for path in sample_dirs
    ]
    payload = {
        "version": 2,
        "speechSilenceGapSeconds": args.speech_silence_gap,
        "pianoSilenceGapSeconds": args.piano_silence_gap,
        "maxPianoActivityNoteDurationSeconds": args.max_activity_note_duration,
        "samples": samples,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )

    print(f"Wrote {len(samples)} samples to {args.output.relative_to(ROOT)}")
    for sample in samples:
        print(
            f"  {sample['id']}: {len(sample['speechSegments'])} speech segments, "
            f"{len(sample['pianoSegments'])} piano segments, "
            f"{len(sample['pedalSegments'])} pedal holds, {len(sample['notes'])} notes"
        )


if __name__ == "__main__":
    main()
