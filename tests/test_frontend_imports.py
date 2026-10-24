"""Static guard for the 'el is not defined' class of frontend bugs.

learn.js builds DOM via helpers imported from shared.js / player-core.js. A
missing import is invisible to our Python/JS unit tests but breaks the page at
runtime (ReferenceError). These checks assert that every helper learn.js *uses*
is actually *imported*, catching the root cause of the transcript "el is not
defined" error without needing a browser.
"""

from __future__ import annotations

import re
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / "public"
LEARN_JS = PUBLIC / "learn.js"


def _imported_names(src: str) -> set[str]:
    names: set[str] = set()
    for m in re.finditer(r"import\s*\{([^}]*)\}\s*from", src):
        for part in m.group(1).split(","):
            name = part.strip().split(" as ")[0].strip()
            if name:
                names.add(name)
    return names


# Helpers that, if called as `name(`, must be imported (they are not defined
# locally in learn.js).
EXTERNAL_HELPERS = {"el", "createPlayerController", "validateFile", "formatTime",
                    "createSearchNav", "createWakeWordListener", "createLooperSession",
                    "createTurnSequencer",
                    "shouldApplyResponseEvent", "reconcileFinalText", "autoScrollDecision"}


def test_learn_js_imports_every_external_helper_it_uses():
    src = LEARN_JS.read_text(encoding="utf-8")
    imported = _imported_names(src)
    for helper in EXTERNAL_HELPERS:
        used = re.search(rf"\b{re.escape(helper)}\s*\(", src)
        if used:
            assert helper in imported, (
                f"learn.js calls {helper}() but does not import it "
                f"(imported: {sorted(imported)})"
            )


def test_el_specifically_imported_from_shared():
    """Regression for the exact reported bug: el() used but not imported."""
    src = LEARN_JS.read_text(encoding="utf-8")
    assert re.search(r"\bel\s*\(", src), "expected learn.js to use el()"
    assert re.search(r"import\s*\{[^}]*\bel\b[^}]*\}\s*from\s*['\"]\./shared\.js['\"]", src), \
        "learn.js must import { el } from './shared.js'"
