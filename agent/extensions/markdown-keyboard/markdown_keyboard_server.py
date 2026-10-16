#!/usr/bin/env python3
"""Localhost-only character and cursor bridge for the Markdown Type Foundry."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
HTML = ROOT / "markdown-keyboard.html"
CAPABILITIES = json.loads((ROOT / "keyboard-capabilities.json").read_text(encoding="utf-8"))


class PhysicalEventRequiredError(ValueError):
    """Production writes must originate in a trusted visible pointer event."""


class CharacterUnavailableError(ValueError):
    """The authoritative constraint rejected a physical key attempt."""

    def __init__(self, character: str, constraint: dict[str, object]) -> None:
        self.character = character
        self.constraint = constraint
        super().__init__(f"letter {character.upper()} is missing from the keyboard right now")


class StaticCharacterConstraint:
    """Deterministic constraint used by focused unit tests."""

    def __init__(self, disabled_characters: set[str] | frozenset[str]) -> None:
        self.disabled_characters = frozenset(disabled_characters)

    def state(self) -> dict[str, object]:
        return {
            "mode": "static",
            "runId": "static",
            "rotationIndex": 0,
            "blockedLetter": next(iter(sorted({value.lower() for value in self.disabled_characters})), None),
            "disabledCharacters": sorted(self.disabled_characters),
            "intervalMs": 0,
            "remainingMs": 0,
            "rotatedAt": None,
            "rotatesAt": None,
        }

    def reset(self) -> dict[str, object]:
        return self.state()

    def history(self) -> list[dict[str, object]]:
        return []


class RotatingLetterConstraint:
    """One random letter disappears for each fixed wall-clock interval."""

    def __init__(
        self,
        alphabet: str,
        interval_seconds: float,
        *,
        chooser=None,
        monotonic_clock=time.monotonic,
        wall_clock=time.time,
    ) -> None:
        normalized = "".join(dict.fromkeys(alphabet.lower()))
        if len(normalized) < 2 or any(not ("a" <= letter <= "z") for letter in normalized):
            raise ValueError("rotating alphabet must contain at least two unique lowercase ASCII letters")
        if interval_seconds <= 0:
            raise ValueError("rotation interval must be positive")
        self.alphabet = normalized
        self.interval_seconds = interval_seconds
        self._choose = chooser or secrets.choice
        self._monotonic = monotonic_clock
        self._wall = wall_clock
        self._lock = threading.RLock()
        self._history: list[dict[str, object]] = []
        self.run_id = ""
        self.rotation_index = -1
        self.blocked_letter = ""
        self.rotated_monotonic = 0.0
        self.rotates_monotonic = 0.0
        self.rotated_wall = 0.0
        self.reset()

    def _next_letter(self, previous: str | None) -> str:
        candidates = [letter for letter in self.alphabet if letter != previous]
        return str(self._choose(candidates))

    def _record_rotation(self) -> None:
        self._history.append({
            "runId": self.run_id,
            "rotationIndex": self.rotation_index,
            "blockedLetter": self.blocked_letter,
            "rotatedAt": self.rotated_wall,
            "rotatesAt": self.rotated_wall + self.interval_seconds,
        })
        if len(self._history) > 10000:
            del self._history[: len(self._history) - 10000]

    def _advance_locked(self, now: float) -> None:
        while now >= self.rotates_monotonic:
            previous = self.blocked_letter
            self.rotated_monotonic = self.rotates_monotonic
            self.rotates_monotonic += self.interval_seconds
            self.rotated_wall += self.interval_seconds
            self.rotation_index += 1
            self.blocked_letter = self._next_letter(previous)
            self._record_rotation()

    def state(self) -> dict[str, object]:
        with self._lock:
            now = self._monotonic()
            self._advance_locked(now)
            remaining_ms = max(0, round((self.rotates_monotonic - now) * 1000))
            disabled = sorted({self.blocked_letter, self.blocked_letter.upper()})
            return {
                "mode": "rotating-letter",
                "runId": self.run_id,
                "rotationIndex": self.rotation_index,
                "blockedLetter": self.blocked_letter,
                "disabledCharacters": disabled,
                "intervalMs": round(self.interval_seconds * 1000),
                "remainingMs": remaining_ms,
                "rotatedAt": self.rotated_wall,
                "rotatesAt": self.rotated_wall + self.interval_seconds,
            }

    def reset(self) -> dict[str, object]:
        with self._lock:
            now = self._monotonic()
            self.run_id = uuid.uuid4().hex
            self.rotation_index = 0
            self.blocked_letter = self._next_letter(None)
            self.rotated_monotonic = now
            self.rotates_monotonic = now + self.interval_seconds
            self.rotated_wall = self._wall()
            self._history = []
            self._record_rotation()
            return self.state()

    def history(self) -> list[dict[str, object]]:
        with self._lock:
            self._advance_locked(self._monotonic())
            return [dict(item) for item in self._history]


def default_constraint() -> RotatingLetterConstraint:
    alphabet = str(CAPABILITIES.get("alphabet", "abcdefghijklmnopqrstuvwxyz"))
    interval_ms = int(CAPABILITIES.get("rotationIntervalMs", 5000))
    return RotatingLetterConstraint(alphabet, interval_ms / 1000)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the visible Markdown keyboard and persist every edit.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--file", type=Path, default=ROOT / "output" / "live-notes.md")
    return parser.parse_args()


@dataclass(frozen=True)
class Snapshot:
    content: str
    cursor: int
    anchor: int


class DocumentStore:
    HISTORY_LIMIT = 500
    GROUP_WINDOW_SECONDS = 0.85

    def __init__(
        self,
        path: Path,
        disabled_characters: set[str] | frozenset[str] | None = None,
        *,
        constraint: StaticCharacterConstraint | RotatingLetterConstraint | None = None,
        physical_only: bool = False,
    ) -> None:
        if disabled_characters is not None and constraint is not None:
            raise ValueError("provide disabled_characters or constraint, not both")
        self.path = path.expanduser().resolve()
        self.physical_only = physical_only
        self.constraint = constraint or (
            StaticCharacterConstraint(disabled_characters)
            if disabled_characters is not None
            else default_constraint()
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.touch(exist_ok=True)
        content = self.path.read_text(encoding="utf-8")
        self.cursor = len(content)
        self.anchor = self.cursor
        self.preferred_column: int | None = None
        self.undo_stack: list[Snapshot] = []
        self.redo_stack: list[Snapshot] = []
        self.last_edit_group: str | None = None
        self.last_edit_time = 0.0
        self.lock = threading.Lock()
        self.sequence = 0
        self.attempt_sequence = 0
        self.last_action = "open"
        self.last_attempt: dict[str, object] | None = None

    def _validate_character(self, character: object) -> tuple[str, dict[str, object]]:
        if not isinstance(character, str) or len(character) != 1:
            raise ValueError("insert requires exactly one character")
        constraint = self.constraint.state()
        if character in constraint["disabledCharacters"]:
            raise CharacterUnavailableError(character, constraint)
        codepoint = ord(character)
        if character in {"\n", "\t"} or 32 <= codepoint <= 126:
            return character, constraint
        raise ValueError("only printable ASCII, newline, and tab are supported")

    def _durable_write(self, content: str) -> None:
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8", newline="") as destination:
            destination.write(content)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, self.path)

    def _snapshot(self, content: str) -> Snapshot:
        return Snapshot(content, self.cursor, self.anchor)

    def _record_history(self, content: str, group: str) -> None:
        now = time.monotonic()
        grouped = group == self.last_edit_group and now - self.last_edit_time <= self.GROUP_WINDOW_SECONDS
        if not grouped:
            self.undo_stack.append(self._snapshot(content))
            if len(self.undo_stack) > self.HISTORY_LIMIT:
                del self.undo_stack[0]
        self.redo_stack.clear()
        self.last_edit_group = group
        self.last_edit_time = now

    def _break_history_group(self) -> None:
        self.last_edit_group = None
        self.last_edit_time = 0.0

    def _selection(self) -> tuple[int, int]:
        return min(self.anchor, self.cursor), max(self.anchor, self.cursor)

    def _replace_selection(self, content: str, replacement: str) -> str:
        start, end = self._selection()
        content = content[:start] + replacement + content[end:]
        self.cursor = start + len(replacement)
        self.anchor = self.cursor
        self.preferred_column = None
        return content

    @staticmethod
    def _character_class(character: str) -> str:
        if character.isspace():
            return "space"
        if character.isalnum() or character == "_":
            return "word"
        return "punctuation"

    @classmethod
    def _word_left(cls, content: str, cursor: int) -> int:
        index = cursor
        while index > 0 and content[index - 1].isspace():
            index -= 1
        punctuation_end = index
        while index > 0 and cls._character_class(content[index - 1]) == "punctuation":
            index -= 1
        word_end = index
        while index > 0 and cls._character_class(content[index - 1]) == "word":
            index -= 1
        if index != word_end:
            return index
        return min(index, punctuation_end)

    @classmethod
    def _word_right(cls, content: str, cursor: int) -> int:
        length = len(content)
        index = cursor
        while index < length and content[index].isspace():
            index += 1
        while index < length and cls._character_class(content[index]) == "punctuation":
            index += 1
        while index < length and cls._character_class(content[index]) == "word":
            index += 1
        while index < length and cls._character_class(content[index]) == "punctuation":
            index += 1
        return index

    @staticmethod
    def _line_start(content: str, cursor: int) -> int:
        newline = content.rfind("\n", 0, cursor)
        return 0 if newline < 0 else newline + 1

    @staticmethod
    def _line_end(content: str, cursor: int) -> int:
        newline = content.find("\n", cursor)
        return len(content) if newline < 0 else newline

    def _vertical_target(self, content: str, cursor: int, direction: int, lines: int = 1) -> int:
        current_start = self._line_start(content, cursor)
        column = cursor - current_start if self.preferred_column is None else self.preferred_column
        self.preferred_column = column
        target = cursor
        for _ in range(lines):
            if direction < 0:
                if current_start == 0:
                    return min(column, self._line_end(content, 0))
                target_end = current_start - 1
                target_start = self._line_start(content, target_end)
            else:
                current_end = self._line_end(content, target)
                if current_end == len(content):
                    return len(content)
                target_start = current_end + 1
                target_end = self._line_end(content, target_start)
            target = min(target_start + column, target_end)
            current_start = target_start
        return target

    def _apply_cursor(self, target: int, extend: bool) -> None:
        self.cursor = target
        if not extend:
            self.anchor = self.cursor

    def _move(self, content: str, direction: str, unit: str, extend: bool, count: int) -> None:
        count = max(1, min(count, 1000))
        start, end = self._selection()
        if not extend and start != end and unit == "character" and direction in {"left", "right"}:
            self._apply_cursor(start if direction == "left" else end, False)
            self.preferred_column = None
            return

        for _ in range(count):
            if direction == "left":
                target = self._word_left(content, self.cursor) if unit == "word" else max(0, self.cursor - 1)
                self.preferred_column = None
            elif direction == "right":
                target = self._word_right(content, self.cursor) if unit == "word" else min(len(content), self.cursor + 1)
                self.preferred_column = None
            elif direction == "up":
                target = self._vertical_target(content, self.cursor, -1, 10 if unit == "page" else 1)
            elif direction == "down":
                target = self._vertical_target(content, self.cursor, 1, 10 if unit == "page" else 1)
            elif direction == "home":
                target = 0 if unit == "document" else self._line_start(content, self.cursor)
                self.preferred_column = None
            elif direction == "end":
                target = len(content) if unit == "document" else self._line_end(content, self.cursor)
                self.preferred_column = None
            else:
                raise ValueError(f"unsupported move direction: {direction}")
            self._apply_cursor(target, extend)

    def _record_attempt(
        self,
        action: str,
        accepted: bool,
        *,
        character: str | None,
        reason: str | None,
        constraint: dict[str, object],
        details: dict[str, object],
    ) -> None:
        self.attempt_sequence += 1
        self.last_attempt = {
            "attemptSequence": self.attempt_sequence,
            "action": action,
            "character": character,
            "accepted": accepted,
            "reason": reason,
            "details": details,
            "runId": constraint.get("runId"),
            "rotationIndex": constraint.get("rotationIndex"),
            "blockedLetter": constraint.get("blockedLetter"),
            "at": time.time(),
        }

    def edit(self, action: str, **payload: object) -> dict[str, object]:
        with self.lock:
            physical_event = payload.pop("_physicalEvent", False)
            if self.physical_only and physical_event is not True:
                raise PhysicalEventRequiredError("production edits require a trusted visible pointer event")
            content = self.path.read_text(encoding="utf-8")
            original = content
            self.cursor = min(self.cursor, len(content))
            self.anchor = min(self.anchor, len(content))
            character: str | None = None
            constraint = self.constraint.state()
            details: dict[str, object] = {}

            if action == "insert":
                try:
                    character, constraint = self._validate_character(payload.get("character"))
                except CharacterUnavailableError as error:
                    self._record_attempt(
                        action,
                        False,
                        character=error.character,
                        reason="character_unavailable",
                        constraint=error.constraint,
                        details={"character": error.character},
                    )
                    self.last_action = "rejected_insert"
                    raise
                details = {"character": character}
                self._record_history(content, "insert")
                content = self._replace_selection(content, character)
            elif action in {"backspace", "delete"}:
                word = bool(payload.get("word", False))
                details = {"word": word}
                start, end = self._selection()
                if start == end:
                    if action == "backspace":
                        start = self._word_left(content, self.cursor) if word else max(0, self.cursor - 1)
                        end = self.cursor
                    else:
                        start = self.cursor
                        end = self._word_right(content, self.cursor) if word else min(len(content), self.cursor + 1)
                if start != end:
                    self._record_history(content, f"{action}-{'word' if word else 'character'}")
                    self.anchor, self.cursor = start, end
                    content = self._replace_selection(content, "")
            elif action == "clear":
                if content:
                    self._record_history(content, "clear")
                    self.anchor, self.cursor = 0, len(content)
                    content = self._replace_selection(content, "")
            elif action == "move":
                self._break_history_group()
                direction = str(payload.get("direction", ""))
                unit = str(payload.get("unit", "character"))
                extend = bool(payload.get("extend", False))
                count = int(payload.get("count", 1))
                details = {"direction": direction, "unit": unit, "extend": extend, "count": count}
                self._move(content, direction, unit, extend, count)
            elif action == "select_all":
                self._break_history_group()
                self.anchor = 0
                self.cursor = len(content)
                self.preferred_column = None
            elif action == "collapse_selection":
                self._break_history_group()
                self.anchor = self.cursor
                self.preferred_column = None
            elif action == "undo":
                self._break_history_group()
                if self.undo_stack:
                    self.redo_stack.append(self._snapshot(content))
                    snapshot = self.undo_stack.pop()
                    content = snapshot.content
                    self.cursor = min(snapshot.cursor, len(content))
                    self.anchor = min(snapshot.anchor, len(content))
                    self.preferred_column = None
            elif action == "redo":
                self._break_history_group()
                if self.redo_stack:
                    self.undo_stack.append(self._snapshot(content))
                    snapshot = self.redo_stack.pop()
                    content = snapshot.content
                    self.cursor = min(snapshot.cursor, len(content))
                    self.anchor = min(snapshot.anchor, len(content))
                    self.preferred_column = None
            else:
                raise ValueError(f"unsupported action: {action}")

            changed = content != original
            if changed:
                self._durable_write(content)
            self._record_attempt(
                action,
                True,
                character=character,
                reason=None,
                constraint=constraint,
                details=details,
            )
            self.sequence += 1
            self.last_action = action
            return self._state(content, changed)

    def reset_constraint(self) -> dict[str, object]:
        with self.lock:
            self.constraint.reset()
            self.last_action = "constraint_reset"
            return self._state(self.path.read_text(encoding="utf-8"), False)

    def constraint_history(self) -> dict[str, object]:
        state = self.constraint.state()
        return {
            "runId": state.get("runId"),
            "intervalMs": state.get("intervalMs"),
            "rotations": self.constraint.history(),
        }

    def state(self) -> dict[str, object]:
        with self.lock:
            content = self.path.read_text(encoding="utf-8")
            self.cursor = min(self.cursor, len(content))
            self.anchor = min(self.anchor, len(content))
            return self._state(content, False)

    def _state(self, content: str, changed: bool) -> dict[str, object]:
        encoded = content.encode("utf-8")
        selection_start, selection_end = self._selection()
        line_start = self._line_start(content, self.cursor)
        constraint = self.constraint.state()
        return {
            "content": content,
            "path": str(self.path),
            "charCount": len(content),
            "byteCount": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "sequence": self.sequence,
            "attemptSequence": self.attempt_sequence,
            "lastAttempt": self.last_attempt,
            "cursor": self.cursor,
            "anchor": self.anchor,
            "selectionStart": selection_start,
            "selectionEnd": selection_end,
            "selectedCount": selection_end - selection_start,
            "line": content.count("\n", 0, self.cursor) + 1,
            "column": self.cursor - line_start + 1,
            "canUndo": bool(self.undo_stack),
            "canRedo": bool(self.redo_stack),
            "lastAction": self.last_action,
            "contentChanged": changed,
            "disabledCharacters": constraint["disabledCharacters"],
            "constraintName": CAPABILITIES.get("constraintName", ""),
            "constraint": constraint,
        }


def create_handler(store: DocumentStore):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MarkdownKeyboard/2.0"

        def log_message(self, format: str, *args: object) -> None:
            print(f"[{self.log_date_time_string()}] {format % args}", flush=True)

        def _json(self, status: int, payload: object) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path in {"/", "/markdown-keyboard.html"}:
                body = HTML.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/document":
                self._json(200, store.state())
                return
            if path == "/api/constraint/history":
                self._json(200, store.constraint_history())
                return
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            if path not in {"/api/edit", "/api/constraint/reset"}:
                self._json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 2 or length > 4096:
                    raise ValueError("invalid request size")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                if path == "/api/constraint/reset":
                    if payload:
                        raise ValueError("constraint reset body must be empty")
                    self._json(200, store.reset_constraint())
                    return
                action = payload.pop("action", "")
                state = store.edit(str(action), **payload)
                self._json(200, state)
            except CharacterUnavailableError as error:
                self._json(409, {
                    "error": str(error),
                    "code": "CHARACTER_UNAVAILABLE",
                    "character": error.character,
                    "constraint": error.constraint,
                    "state": store.state(),
                })
            except PhysicalEventRequiredError as error:
                self._json(403, {"error": str(error), "code": "PHYSICAL_EVENT_REQUIRED"})
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as error:
                self._json(400, {"error": str(error)})
            except OSError as error:
                self._json(500, {"error": f"file write failed: {error}"})

    return Handler


def main() -> None:
    args = parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("Refusing non-loopback host; this write bridge is localhost-only.")
    store = DocumentStore(args.file, physical_only=True)
    server = ThreadingHTTPServer((args.host, args.port), create_handler(store))
    print(json.dumps({
        "url": f"http://{args.host}:{args.port}/",
        "file": str(store.path),
        "pid": os.getpid(),
    }), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
