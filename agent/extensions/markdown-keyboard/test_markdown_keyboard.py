from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import sys
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


server_module = load_module("markdown_keyboard_server", "markdown_keyboard_server.py")
typist_module = load_module("physical_markdown_typist", "physical_markdown_typist.py")


class DocumentStoreTests(unittest.TestCase):
    def test_printable_ascii_newline_tab_backspace_and_clear(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", disabled_characters=set())
            expected = "".join(chr(code) for code in range(32, 127)) + "\n\t"
            for character in expected:
                store.edit("insert", character=character)
            self.assertEqual(store.state()["content"], expected)
            store.edit("backspace")
            self.assertEqual(store.state()["content"], expected[:-1])
            store.edit("clear")
            self.assertEqual(store.state()["content"], "")

    def test_rejects_non_ascii_and_multicharacter_insert(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", disabled_characters=set())
            with self.assertRaises(ValueError):
                store.edit("insert", character="—")
            with self.assertRaises(ValueError):
                store.edit("insert", character="ab")

    def test_rotating_constraint_releases_previous_letter_after_five_seconds(self):
        class Clock:
            value = 10.0

            def monotonic(self):
                return self.value

            def wall(self):
                return 1000.0 + self.value

        choices = iter(["s", "a"])
        clock = Clock()
        constraint = server_module.RotatingLetterConstraint(
            "abcdefghijklmnopqrstuvwxyz",
            5.0,
            chooser=lambda _candidates: next(choices),
            monotonic_clock=clock.monotonic,
            wall_clock=clock.wall,
        )
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", constraint=constraint)
            self.assertEqual(store.state()["disabledCharacters"], ["S", "s"])
            with self.assertRaisesRegex(server_module.CharacterUnavailableError, "letter S is missing"):
                store.edit("insert", character="s")
            rejected = store.state()["lastAttempt"]
            self.assertFalse(rejected["accepted"])
            self.assertEqual(rejected["rotationIndex"], 0)
            clock.value += 5.01
            store.edit("insert", character="s")
            self.assertEqual(store.state()["content"], "s")
            with self.assertRaisesRegex(server_module.CharacterUnavailableError, "letter A is missing"):
                store.edit("insert", character="A")
            self.assertEqual([item["blockedLetter"] for item in constraint.history()], ["s", "a"])

    def test_cursor_selection_replacement_and_word_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", disabled_characters=set())
            for character in "alpha beta gamma":
                store.edit("insert", character=character)
            store.edit("move", direction="home", unit="document", extend=False, count=1)
            store.edit("move", direction="right", unit="character", extend=True, count=5)
            selected = store.state()
            self.assertEqual(selected["selectedCount"], 5)
            self.assertEqual(selected["content"][selected["selectionStart"]:selected["selectionEnd"]], "alpha")
            store.edit("insert", character="A")
            self.assertEqual(store.state()["content"], "A beta gamma")
            store.edit("move", direction="end", unit="document", extend=False, count=1)
            store.edit("backspace", word=True)
            self.assertEqual(store.state()["content"], "A beta ")
            store.edit("move", direction="home", unit="document", extend=False, count=1)
            store.edit("delete", word=True)
            self.assertEqual(store.state()["content"], " beta ")

    def test_word_deletion_includes_attached_punctuation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", disabled_characters=set())
            for character in "Keep this outcome.":
                store.edit("insert", character=character)
            store.edit("backspace", word=True)
            self.assertEqual(store.state()["content"], "Keep this ")

    def test_vertical_movement_preserves_preferred_column(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", disabled_characters=set())
            for character in "abcde\nxy\n12345":
                store.edit("insert", character=character)
            store.edit("move", direction="home", unit="document", extend=False, count=1)
            store.edit("move", direction="right", unit="character", extend=False, count=4)
            store.edit("move", direction="down", unit="character", extend=False, count=1)
            self.assertEqual((store.state()["line"], store.state()["column"]), (2, 3))
            store.edit("move", direction="down", unit="character", extend=False, count=1)
            self.assertEqual((store.state()["line"], store.state()["column"]), (3, 5))
            store.edit("move", direction="up", unit="character", extend=True, count=1)
            self.assertGreater(store.state()["selectedCount"], 0)

    def test_undo_redo_and_clear_are_reversible(self):
        with tempfile.TemporaryDirectory() as directory:
            store = server_module.DocumentStore(Path(directory) / "document.md", disabled_characters=set())
            for character in "editable":
                store.edit("insert", character=character)
            store.edit("clear")
            self.assertEqual(store.state()["content"], "")
            store.edit("undo")
            self.assertEqual(store.state()["content"], "editable")
            self.assertTrue(store.state()["canRedo"])
            store.edit("redo")
            self.assertEqual(store.state()["content"], "")


class PhysicalMappingTests(unittest.TestCase):
    def test_every_supported_character_maps_to_visible_keys(self):
        supported = "".join(chr(code) for code in range(32, 127)) + "\n\t"
        for character in supported:
            actions = typist_module.actions_for_character(character)
            self.assertTrue(actions, repr(character))
            for action in actions:
                self.assertIn(action, typist_module.KEYS, (character, action))

    def test_acknowledgement_matching_includes_semantic_command_details(self):
        expected = typist_module.COMMAND_EXPECTED_DETAILS["SELECT_WORD_LEFT"]
        correct = {
            "action": "move",
            "character": None,
            "details": dict(expected),
        }
        self.assertTrue(typist_module.attempt_matches(correct, "move", None, expected))
        wrong_unit = {**correct, "details": {**expected, "unit": "character"}}
        wrong_extend = {**correct, "details": {**expected, "extend": False}}
        self.assertFalse(typist_module.attempt_matches(wrong_unit, "move", None, expected))
        self.assertFalse(typist_module.attempt_matches(wrong_extend, "move", None, expected))

    def test_every_edit_command_maps_to_visible_keys(self):
        required = {
            "UNDO", "REDO", "SELECT_ALL", "DESELECT", "DOC_HOME", "HOME", "UP", "END",
            "DOC_END", "DELETE", "BACKSPACE", "BACKSPACE_WORD", "WORD_LEFT", "LEFT", "DOWN",
            "RIGHT", "WORD_RIGHT", "PAGE_UP", "PAGE_DOWN", "DELETE_WORD", "SELECT_LEFT",
            "SELECT_RIGHT", "SELECT_UP", "SELECT_DOWN", "SELECT_HOME", "SELECT_END",
            "SELECT_WORD_LEFT", "SELECT_WORD_RIGHT", "SELECT_DOC_HOME", "SELECT_DOC_END",
        }
        self.assertTrue(required.issubset(typist_module.COMMAND_ACTIONS))
        self.assertTrue(required.issubset(typist_module.COMMAND_EXPECTED_ACTION))
        self.assertTrue(required.issubset(typist_module.COMMAND_EXPECTED_DETAILS))
        for command in required:
            for action in typist_module.actions_for_command(command):
                self.assertIn(action, typist_module.KEYS, (command, action))


class HttpApiTests(unittest.TestCase):
    def test_production_store_rejects_nonphysical_http_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            file_path = Path(directory) / "physical-only.md"
            store = server_module.DocumentStore(file_path, disabled_characters=set(), physical_only=True)
            httpd = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.create_handler(store))
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{httpd.server_port}"
            try:
                request = urllib.request.Request(
                    base + "/api/edit",
                    data=json.dumps({"action": "insert", "character": "a"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(request)
                self.assertEqual(raised.exception.code, 403)
                payload = json.loads(raised.exception.read().decode("utf-8"))
                self.assertEqual(payload["code"], "PHYSICAL_EVENT_REQUIRED")
                self.assertEqual(file_path.read_text(encoding="utf-8"), "")
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=2)

    def test_missing_letter_returns_conflict_and_authoritative_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            file_path = Path(directory) / "rejected.md"
            constraint = server_module.RotatingLetterConstraint(
                "abcdefghijklmnopqrstuvwxyz",
                5.0,
                chooser=lambda candidates: "s" if "s" in candidates else candidates[0],
            )
            store = server_module.DocumentStore(file_path, constraint=constraint)
            httpd = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.create_handler(store))
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{httpd.server_port}"
            try:
                request = urllib.request.Request(
                    base + "/api/edit",
                    data=json.dumps({"action": "insert", "character": "S"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(request)
                self.assertEqual(raised.exception.code, 409)
                payload = json.loads(raised.exception.read().decode("utf-8"))
                self.assertEqual(payload["code"], "CHARACTER_UNAVAILABLE")
                self.assertEqual(payload["character"], "S")
                self.assertEqual(payload["state"]["attemptSequence"], 1)
                self.assertFalse(payload["state"]["lastAttempt"]["accepted"])
                self.assertEqual(file_path.read_text(encoding="utf-8"), "")
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=2)

    def test_api_persists_markdown_and_returns_authoritative_state(self):
        with tempfile.TemporaryDirectory() as directory:
            file_path = Path(directory) / "api.md"
            store = server_module.DocumentStore(file_path, disabled_characters=set())
            httpd = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.create_handler(store))
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{httpd.server_port}"
            try:
                markdown = "# Test\n\n- [x] **works**\n"
                for character in markdown:
                    request = urllib.request.Request(
                        base + "/api/edit",
                        data=json.dumps({"action": "insert", "character": character}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(request) as response:
                        state = json.load(response)
                self.assertEqual(state["content"], markdown)
                self.assertEqual(file_path.read_text(encoding="utf-8"), markdown)
                with urllib.request.urlopen(base + "/api/document") as response:
                    authoritative = json.load(response)
                self.assertEqual(authoritative["content"], markdown)
                self.assertEqual(authoritative["sequence"], len(markdown))
            finally:
                httpd.shutdown()
                httpd.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
