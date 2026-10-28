"""Checks for the spreadsheet importer's cell reading. Run: python tests/test_import.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import import_tracking as it  # noqa: E402

NAMES = sorted(["basic scale", "hallelujah", "hallelujah 2", "hallelujah 3", "hum", "hum 3", "nasal hum",
                "va", "vavevivovu", "vavevivovu - a", "mimema", "mini", "do", "gliss", "dynamic vi", "brr",
                "louis", "up down up", "evil laugh", "evil laugh 2", "evil laugh 3", "kiki", "yo eee", "א-ת"],
               key=len, reverse=True)


def read(*cells):
    s = it.Session()
    notes = []
    for c in cells:
        notes += it.read_cell(c, NAMES, s, it.Report(), "2026-01-01")
    return {ex: e["tags"] for ex, e in s.entries.items()}, notes, s


def test_variations():
    assert read("basic scale g#4")[0] == {"basic scale": ["g#4"]}
    assert read("hallelujah up to d4")[0] == {"hallelujah": ["up to d4"]}
    assert read("hum 3")[0] == {"hum 3": []}
    assert read("vavevivovu")[0] == {"vavevivovu": []}


def test_breathing():
    assert read("all breathing 35s\n5 sfch")[0] == {"sfch": ["set order", "random order", "5 sfch"], "holding breath": ["35s"]}
    assert read("sfch no random\n35s")[0] == {"sfch": ["set order"], "holding breath": ["35s"]}
    assert read("no random, 25s")[0] == {"sfch": ["set order"], "holding breath": ["25s"]}
    assert read("all breathing 35s\nthen 37s")[0] == {"sfch": ["set order", "random order"], "holding breath": ["35s then 37s"]}
    assert read("sfch")[0] == {"sfch": ["set order"]}
    assert read("sfch 5 sfch")[0] == {"sfch": ["set order", "5 sfch"]}
    assert read("sfch songs")[0] == {"sfch": ["songs"]}
    assert read("30s")[0] == {"holding breath": ["30s"]}
    assert read("all breathing 60s no prog")[0]["holding breath"] == ["60s no prog"]
    entries, _, s = read("all breathing 20s\n5 sfch, nervs")
    assert s.entries["sfch"]["notes"] == ["nervs"]


def test_combined_exercises():
    assert read("evil laugh 2 random")[0] == {"evil laugh": ["2", "random"]}
    assert read("evil laugh 2", "evil laugh 3")[0] == {"evil laugh": ["2", "3"]}
    assert read("vavevivovu - a")[0] == {"vavevivovu": ["a"]}
    assert read("mimema we")[0] == {"vavevivovu": ["mimema", "we"]}
    assert read("nasal hum")[0] == {"hum": ["nasal"]}
    assert read("dynamic vi", "gliss")[0] == {"gliss": ["octave", "compound"]}
    assert read("gliss brr")[0] == {"gliss": ["brr"]}
    assert read("brr gliss")[0] == {"gliss": ["brr"]}
    assert read("brr up down up")[0] == {"up down up": ["brr"]}


def test_second_lines_and_notes():
    assert read("mini up to no head\ndown")[0] == {"mini": ["up to no head down"]}
    assert read("evil laugh 3\nno head")[0] == {"evil laugh": ["3", "no head"]}
    entries, notes, s = read("do\n(not a lot)")
    assert entries == {"do": []} and s.entries["do"]["notes"] == ["not a lot"] and notes == []
    assert read("throat still bad")[:2] == ({}, ["throat still bad"])
    assert read("none")[0] == {}
    assert read("loius")[0] == {"louis": []}
    assert read("yo")[0] == {"yo eee": []}


def test_lesson_split():
    own, lesson = it.split_row(["sfch no random", "dynamic vi", "vivivi", None, None, "hum", "mouth hum"])
    assert own == ["sfch no random", "dynamic vi", "vivivi"] and lesson == ["hum", "mouth hum"]
    own, lesson = it.split_row([None, None, None, None, "sfch", "hum", "ree"])
    assert own == [] and lesson == ["sfch", "hum", "ree"]
    own, lesson = it.split_row([" ", "ma_a_a", "kiti", "vibrato", None, None, None])
    assert own == ["ma_a_a", "kiti", "vibrato"] and lesson == []
    own, lesson = it.split_row(["sfch no random", "dynamic vi", "mimema", "do", "gliss", "do", None], 4)
    assert own == ["sfch no random", "dynamic vi", "mimema", "do"] and lesson == ["gliss", "do"]


def test_ids_and_serialize():
    assert it.slug("א-ת") == "alef-tav"
    assert it.slug("holding breath") == "holding-breath"
    doc = {"categories": [], "days": [], "exercises": [],
           "entries": [{"updated": "t", "note": "", "variations": ["a"], "lesson": True, "exercise": "x", "date": "2026-01-01", "id": "h1"}]}
    text = it.serialize(doc)
    assert '    {"id":"h1","date":"2026-01-01","exercise":"x","variations":["a"],"lesson":true,"note":"","updated":"t"}\n' in text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
