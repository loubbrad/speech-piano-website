import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import mido


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "prepare", ROOT / "scripts" / "prepare.py"
)
assert SPEC and SPEC.loader
prepare = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = prepare
SPEC.loader.exec_module(prepare)


class MidiPreparationTest(unittest.TestCase):
    def test_duplicate_note_on_does_not_shift_later_note_offsets(self) -> None:
        midi = mido.MidiFile(type=0, ticks_per_beat=500)
        track = mido.MidiTrack()
        midi.tracks.append(track)
        track.extend(
            [
                mido.MetaMessage("set_tempo", tempo=500_000, time=0),
                mido.Message("note_off", note=72, velocity=0, time=0),
                mido.Message("note_on", note=72, velocity=90, time=0),
                mido.Message("note_on", note=72, velocity=95, time=0),
                mido.Message("control_change", control=64, value=127, time=50),
                mido.Message("note_off", note=72, velocity=0, time=50),
                mido.Message("control_change", control=64, value=0, time=50),
                mido.Message("note_on", note=72, velocity=60, time=50),
                mido.Message("note_off", note=72, velocity=0, time=100),
            ]
        )

        with tempfile.NamedTemporaryFile(suffix=".mid") as midi_file:
            midi.save(midi_file.name)
            notes, pedal = prepare.read_midi(Path(midi_file.name))

        self.assertEqual(
            notes,
            [
                {
                    "start": 0.0,
                    "end": 0.1,
                    "pitch": 72,
                    "velocity": 95,
                    "channel": 0,
                },
                {
                    "start": 0.2,
                    "end": 0.3,
                    "pitch": 72,
                    "velocity": 60,
                    "channel": 0,
                },
            ],
        )
        self.assertEqual(pedal, [{"start": 0.05, "end": 0.15}])

    def test_activity_cap_does_not_modify_displayed_notes(self) -> None:
        notes = [
            {"start": 0.0, "end": 20.0},
            {"start": 10.0, "end": 10.5},
        ]

        segments = prepare.build_piano_segments(
            notes, silence_gap=1.0, max_activity_note_duration=5.0
        )

        self.assertEqual(notes[0]["end"], 20.0)
        self.assertEqual(
            segments,
            [
                {"start": 0.0, "end": 5.0, "noteCount": 1},
                {"start": 10.0, "end": 10.5, "noteCount": 1},
            ],
        )


if __name__ == "__main__":
    unittest.main()
