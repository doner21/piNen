#!/usr/bin/env python3
"""Consume text deltas and edit commands by clicking the visible Markdown keyboard."""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes
import json
from pathlib import Path
import time
import urllib.request

USER32 = ctypes.windll.user32
HWND = ctypes.wintypes.HWND
USER32.SetWindowPos.argtypes = [HWND, HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint]
USER32.SetWindowPos.restype = ctypes.wintypes.BOOL
USER32.ShowWindow.argtypes = [HWND, ctypes.c_int]
USER32.ShowWindow.restype = ctypes.wintypes.BOOL
USER32.BringWindowToTop.argtypes = [HWND]
USER32.BringWindowToTop.restype = ctypes.wintypes.BOOL
USER32.SetForegroundWindow.argtypes = [HWND]
USER32.SetForegroundWindow.restype = ctypes.wintypes.BOOL
HWND_TOPMOST = HWND(-1)
HWND_NOTOPMOST = HWND(-2)
ROOT = Path(__file__).resolve().parent

# Edge app: x=18, y=10, 930x1040 on a 1920x1080 desktop.
KEYS = {
    # Editing deck.
    "UNDO": (131, 524), "REDO": (207, 524), "SELECT_ALL": (289, 524),
    "COLLAPSE": (370, 524), "DOC_HOME": (448, 524), "HOME": (523, 524),
    "UP": (600, 524), "END": (679, 524), "DOC_END": (757, 524), "DELETE": (834, 524),
    "BACKSPACE_WORD": (175, 564), "WORD_LEFT": (252, 564), "LEFT": (329, 564),
    "DOWN": (405, 564), "RIGHT": (483, 564), "WORD_RIGHT": (560, 564),
    "PAGE_UP": (638, 564), "PAGE_DOWN": (715, 564), "DELETE_WORD": (790, 564),
    # Printable keyboard.
    "`": (94, 637), "1": (150, 637), "2": (206, 637), "3": (262, 637),
    "4": (318, 637), "5": (374, 637), "6": (430, 637), "7": (486, 637),
    "8": (542, 637), "9": (598, 637), "0": (654, 637), "-": (710, 637),
    "=": (766, 637), "BACKSPACE": (847, 637),
    "TAB": (119, 684), "q": (187, 684), "w": (243, 684), "e": (299, 684),
    "r": (355, 684), "t": (411, 684), "y": (467, 684), "u": (523, 684),
    "i": (579, 684), "o": (635, 684), "p": (691, 684), "[": (747, 684),
    "]": (803, 684), "\\": (859, 684),
    "SHIFT": (118, 730), "a": (194, 730), "s": (250, 730), "d": (306, 730),
    "f": (362, 730), "g": (418, 730), "h": (474, 730), "j": (530, 730),
    "k": (586, 730), "l": (642, 730), ";": (698, 730), "'": (754, 730),
    "ENTER": (839, 730),
    "z": (230, 776), "x": (286, 776), "c": (342, 776), "v": (398, 776),
    "b": (454, 776), "n": (510, 776), "m": (566, 776), ",": (622, 776),
    ".": (678, 776), "/": (734, 776), "SPACE": (540, 822), "CTRL": (175, 822),
}

SHIFTED = {
    "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
    "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-",
    "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
    "<": ",", ">": ".", "?": "/",
}

COMMAND_ACTIONS = {
    "UNDO": ["UNDO"], "REDO": ["REDO"], "SELECT_ALL": ["SELECT_ALL"],
    "DESELECT": ["COLLAPSE"], "DOC_HOME": ["DOC_HOME"], "HOME": ["HOME"],
    "UP": ["UP"], "END": ["END"], "DOC_END": ["DOC_END"], "DELETE": ["DELETE"],
    "BACKSPACE": ["BACKSPACE"], "BACKSPACE_WORD": ["BACKSPACE_WORD"],
    "WORD_LEFT": ["WORD_LEFT"], "LEFT": ["LEFT"], "DOWN": ["DOWN"],
    "RIGHT": ["RIGHT"], "WORD_RIGHT": ["WORD_RIGHT"], "PAGE_UP": ["PAGE_UP"],
    "PAGE_DOWN": ["PAGE_DOWN"], "DELETE_WORD": ["DELETE_WORD"],
    "SELECT_LEFT": ["SHIFT", "LEFT"], "SELECT_RIGHT": ["SHIFT", "RIGHT"],
    "SELECT_UP": ["SHIFT", "UP"], "SELECT_DOWN": ["SHIFT", "DOWN"],
    "SELECT_HOME": ["SHIFT", "HOME"], "SELECT_END": ["SHIFT", "END"],
    "SELECT_WORD_LEFT": ["SHIFT", "WORD_LEFT"],
    "SELECT_WORD_RIGHT": ["SHIFT", "WORD_RIGHT"],
    "SELECT_DOC_HOME": ["SHIFT", "DOC_HOME"],
    "SELECT_DOC_END": ["SHIFT", "DOC_END"],
}

COMMAND_EXPECTED_ACTION = {
    "UNDO": "undo", "REDO": "redo", "SELECT_ALL": "select_all",
    "DESELECT": "collapse_selection", "DOC_HOME": "move", "HOME": "move",
    "UP": "move", "END": "move", "DOC_END": "move", "DELETE": "delete",
    "BACKSPACE": "backspace", "BACKSPACE_WORD": "backspace", "WORD_LEFT": "move",
    "LEFT": "move", "DOWN": "move", "RIGHT": "move", "WORD_RIGHT": "move",
    "PAGE_UP": "move", "PAGE_DOWN": "move", "DELETE_WORD": "delete",
    "SELECT_LEFT": "move", "SELECT_RIGHT": "move", "SELECT_UP": "move",
    "SELECT_DOWN": "move", "SELECT_HOME": "move", "SELECT_END": "move",
    "SELECT_WORD_LEFT": "move", "SELECT_WORD_RIGHT": "move",
    "SELECT_DOC_HOME": "move", "SELECT_DOC_END": "move",
}


def move_details(direction: str, unit: str = "character", extend: bool = False) -> dict[str, object]:
    return {"direction": direction, "unit": unit, "extend": extend, "count": 1}


COMMAND_EXPECTED_DETAILS: dict[str, dict[str, object]] = {
    "UNDO": {}, "REDO": {}, "SELECT_ALL": {}, "DESELECT": {},
    "DOC_HOME": move_details("home", "document"),
    "HOME": move_details("home", "line"),
    "UP": move_details("up"),
    "END": move_details("end", "line"),
    "DOC_END": move_details("end", "document"),
    "DELETE": {"word": False},
    "BACKSPACE": {"word": False},
    "BACKSPACE_WORD": {"word": True},
    "WORD_LEFT": move_details("left", "word"),
    "LEFT": move_details("left"),
    "DOWN": move_details("down"),
    "RIGHT": move_details("right"),
    "WORD_RIGHT": move_details("right", "word"),
    "PAGE_UP": move_details("up", "page"),
    "PAGE_DOWN": move_details("down", "page"),
    "DELETE_WORD": {"word": True},
    "SELECT_LEFT": move_details("left", extend=True),
    "SELECT_RIGHT": move_details("right", extend=True),
    "SELECT_UP": move_details("up", extend=True),
    "SELECT_DOWN": move_details("down", extend=True),
    "SELECT_HOME": move_details("home", "line", True),
    "SELECT_END": move_details("end", "line", True),
    "SELECT_WORD_LEFT": move_details("left", "word", True),
    "SELECT_WORD_RIGHT": move_details("right", "word", True),
    "SELECT_DOC_HOME": move_details("home", "document", True),
    "SELECT_DOC_END": move_details("end", "document", True),
}


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, default=root / "markdown-stream.queue")
    parser.add_argument("--log", type=Path, default=root / "markdown-typist.log")
    parser.add_argument("--move-ms", type=float, default=32.0)
    parser.add_argument("--press-ms", type=float, default=8.0)
    parser.add_argument("--pause-ms", type=float, default=30.0)
    parser.add_argument("--window-title", default="Markdown Type Foundry")
    parser.add_argument("--api", default="")
    parser.add_argument("--ack", type=Path)
    parser.add_argument("--ack-timeout-ms", type=float, default=1500.0)
    return parser.parse_args()


def find_window(title_fragment: str) -> int:
    matches: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

    @callback_type
    def callback(hwnd: int, _lparam: int) -> bool:
        if not USER32.IsWindowVisible(hwnd):
            return True
        length = USER32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        USER32.GetWindowTextW(hwnd, buffer, length + 1)
        if title_fragment.lower() in buffer.value.lower():
            matches.append(hwnd)
        return True

    USER32.EnumWindows(callback, 0)
    if not matches:
        raise RuntimeError(f"visible window not found: {title_fragment!r}")
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one visible keyboard window, found {len(matches)}")
    return matches[0]


def activate_keyboard_window(hwnd: int) -> None:
    # Keep the calibrated keyboard topmost for the physical session so another app
    # cannot intercept coordinates between streamed deltas.
    USER32.ShowWindow(hwnd, 9)
    USER32.SetWindowPos(HWND(hwnd), HWND_TOPMOST, 18, 10, 930, 1040, 0x0040)
    USER32.BringWindowToTop(hwnd)
    USER32.SetForegroundWindow(hwnd)
    time.sleep(0.12)


def release_keyboard_window(hwnd: int) -> None:
    USER32.SetWindowPos(HWND(hwnd), HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)


def pointer_position() -> tuple[int, int]:
    point = ctypes.wintypes.POINT()
    USER32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def move_to(x: int, y: int, duration: float) -> None:
    start_x, start_y = pointer_position()
    steps = max(2, round(duration / 0.008))
    for index in range(1, steps + 1):
        progress = index / steps
        eased = progress * progress * (3 - 2 * progress)
        USER32.SetCursorPos(
            round(start_x + (x - start_x) * eased),
            round(start_y + (y - start_y) * eased),
        )
        time.sleep(duration / steps)


def click_key(key: str, move_seconds: float, press_seconds: float, pause_seconds: float) -> None:
    x, y = KEYS[key]
    move_to(x, y, move_seconds)
    USER32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(press_seconds)
    USER32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(pause_seconds)


def actions_for_character(character: str) -> list[str]:
    if "a" <= character <= "z" or character.isdigit() or character in "`-=[]\\;',./":
        return [character]
    if "A" <= character <= "Z":
        return ["SHIFT", character.lower()]
    if character in SHIFTED:
        return ["SHIFT", SHIFTED[character]]
    if character == " ":
        return ["SPACE"]
    if character == "\n":
        return ["ENTER"]
    if character == "\t":
        return ["TAB"]
    raise ValueError(f"unsupported character: U+{ord(character):04X} {character!r}")


def actions_for_command(command: str) -> list[str]:
    try:
        return COMMAND_ACTIONS[command.upper()]
    except KeyError as error:
        raise ValueError(f"unsupported edit command: {command}") from error


def api_document(api: str) -> dict[str, object]:
    with urllib.request.urlopen(f"{api.rstrip('/')}/api/document", timeout=2) as response:
        return json.load(response)


def attempt_matches(
    attempt: dict[str, object],
    expected_action: str,
    expected_character: str | None,
    expected_details: dict[str, object],
) -> bool:
    return (
        attempt.get("action") == expected_action
        and attempt.get("character") == expected_character
        and attempt.get("details") == expected_details
    )


def wait_for_attempt(
    api: str,
    after: int,
    timeout_seconds: float,
    expected_action: str,
    expected_character: str | None,
    expected_details: dict[str, object],
) -> dict[str, object]:
    deadline = time.monotonic() + timeout_seconds
    last_state: dict[str, object] | None = None
    while time.monotonic() < deadline:
        last_state = api_document(api)
        attempt = last_state.get("lastAttempt")
        if isinstance(attempt, dict):
            sequence = int(attempt.get("attemptSequence", 0))
            if sequence > after:
                if attempt_matches(attempt, expected_action, expected_character, expected_details):
                    return last_state
                raise RuntimeError(
                    "physical click acknowledgement mismatch: "
                    f"expected action={expected_action!r} character={expected_character!r} details={expected_details!r}; "
                    f"observed {attempt!r}"
                )
        time.sleep(0.001)
    observed = None if last_state is None else last_state.get("attemptSequence")
    raise TimeoutError(f"visible key click was not acknowledged after attempt {after}; observed {observed}")


def append_ack(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="") as destination:
        destination.write(json.dumps(payload, ensure_ascii=True) + "\n")
        destination.flush()


def main() -> None:
    args = parse_args()
    if bool(args.api) != bool(args.ack):
        raise ValueError("--api and --ack must be supplied together")
    args.queue.parent.mkdir(parents=True, exist_ok=True)
    args.queue.touch(exist_ok=True)
    if args.ack:
        args.ack.parent.mkdir(parents=True, exist_ok=True)
        args.ack.touch(exist_ok=True)
    hwnd = find_window(args.window_title)
    activate_keyboard_window(hwnd)
    args.log.write_text(json.dumps({"status": "ready", "window": args.window_title, "hwnd": hwnd}) + "\n", encoding="utf-8")
    offset = 0
    timings = tuple(value / 1000 for value in (args.move_ms, args.press_ms, args.pause_ms))
    timeout_seconds = args.ack_timeout_ms / 1000

    def perform(
        actions: list[str],
        expected_action: str,
        expected_character: str | None,
        expected_details: dict[str, object],
    ) -> tuple[int, dict[str, object] | None]:
        if not args.api:
            for key in actions:
                click_key(key, *timings)
            return len(actions), None
        last_error: TimeoutError | None = None
        for retry in range(3):
            before = int(api_document(args.api)["attemptSequence"])
            if retry:
                activate_keyboard_window(hwnd)
            for key in actions:
                click_key(key, *timings)
            try:
                return len(actions), wait_for_attempt(
                    args.api,
                    before,
                    timeout_seconds,
                    expected_action,
                    expected_character,
                    expected_details,
                )
            except TimeoutError as error:
                last_error = error
                with args.log.open("a", encoding="utf-8") as log:
                    log.write(json.dumps({
                        "kind": "click-retry",
                        "retry": retry + 1,
                        "actions": actions,
                        "reason": str(error),
                    }) + "\n")
                if len(actions) != 1:
                    break
        assert last_error is not None
        raise last_error

    try:
        while True:
            size = args.queue.stat().st_size
            if size < offset:
                raise RuntimeError("queue was truncated while the physical typist owned it")
            with args.queue.open("r", encoding="utf-8") as source:
                source.seek(offset)
                while True:
                    line = source.readline()
                    if not line:
                        break
                    offset = source.tell()
                    entry = json.loads(line)
                    if entry == "__STOP__":
                        with args.log.open("a", encoding="utf-8") as log:
                            log.write("stopped\n")
                        return

                    started = time.perf_counter()
                    entry_id: object = None
                    total_clicks = 0
                    state: dict[str, object] | None = None
                    if isinstance(entry, str):
                        kind = "text"
                        detail: object = entry
                        text = entry
                    elif isinstance(entry, dict) and isinstance(entry.get("text"), str):
                        kind = "text"
                        text = entry["text"]
                        detail = text
                        entry_id = entry.get("id")
                        if entry_id is not None and len(text) != 1:
                            raise ValueError("acknowledged text entries must contain exactly one character")
                    elif isinstance(entry, dict) and isinstance(entry.get("command"), str):
                        kind = "command"
                        text = ""
                        count = max(1, min(int(entry.get("count", 1)), 1000))
                        detail = {"command": entry["command"].upper(), "count": count}
                        entry_id = entry.get("id")
                    else:
                        raise ValueError("queue entries must be text strings, text objects, or command objects")

                    if kind == "text":
                        for character in text:
                            clicks, state = perform(
                                actions_for_character(character),
                                "insert",
                                character,
                                {"character": character},
                            )
                            total_clicks += clicks
                            attempt = None if state is None else state.get("lastAttempt")
                            if isinstance(attempt, dict) and not bool(attempt.get("accepted")):
                                break
                    else:
                        for _ in range(int(detail["count"])):
                            command = str(detail["command"])
                            clicks, state = perform(
                                actions_for_command(command),
                                COMMAND_EXPECTED_ACTION[command],
                                None,
                                COMMAND_EXPECTED_DETAILS[command],
                            )
                            total_clicks += clicks
                            attempt = None if state is None else state.get("lastAttempt")
                            if isinstance(attempt, dict) and not bool(attempt.get("accepted")):
                                break

                    elapsed = time.perf_counter() - started
                    attempt = None if state is None else state.get("lastAttempt")
                    record = {
                        "kind": kind,
                        "entry": detail,
                        "clicks": total_clicks,
                        "seconds": round(elapsed, 3),
                    }
                    with args.log.open("a", encoding="utf-8") as log:
                        log.write(json.dumps(record, ensure_ascii=True) + "\n")
                    if args.ack and entry_id is not None:
                        append_ack(args.ack, {
                            "id": entry_id,
                            "kind": kind,
                            "entry": detail,
                            "accepted": bool(isinstance(attempt, dict) and attempt.get("accepted")),
                            "attempt": attempt,
                            "constraint": None if state is None else state.get("constraint"),
                            "cursor": None if state is None else state.get("cursor"),
                            "charCount": None if state is None else state.get("charCount"),
                            "sha256": None if state is None else state.get("sha256"),
                        })
            time.sleep(0.025)
    finally:
        release_keyboard_window(hwnd)


if __name__ == "__main__":
    main()
