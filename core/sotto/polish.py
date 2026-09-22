"""Turn raw transcript into text you would have typed.

This is the step that separates a dictation toy from something you actually
use: removing fillers, restoring punctuation, honouring spoken corrections
("no wait, make that Tuesday"), and formatting lists.

Backends:
  ollama  Local LLM over HTTP. Default. ~250ms for a short utterance with
          a 4B model on a 4090.
  rules   Deterministic cleanup. Instant, no dependencies, much dumber.
          Also the automatic fallback whenever the LLM is unreachable.
  off     Pass the transcript through untouched.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request

from . import log
from .config import Config

_log = log.get("polish")

SYSTEM_PROMPT = """\
You clean up voice dictation. The user spoke; a speech recogniser produced \
the text below. Rewrite it as the user intended to write it.

Rules:
- Remove fillers (um, uh, like, you know, euh, ben, allez).
- Fix punctuation, capitalisation and obvious recognition errors.
- When the speaker corrects themselves, keep ONLY what they settled on.
  Delete the abandoned version and the correction phrase itself ("no wait",
  "sorry", "I mean"). The last thing they said is what they meant.
- Apart from those deletions, keep every clause. Never summarise or shorten.
- Keep it as prose. Use a markdown list only if the speaker explicitly asks
  for one or dictates numbered items ("first... second...").
- Keep the speaker's language, tone, register and meaning. Do not translate.
- Do not answer, explain, summarise or add anything.

Output only the cleaned text. No preamble, no quotes, no commentary."""

_FILLERS = re.compile(
    r"\b(um+|uh+|erm+|hmm+|euh+|heu+|ben|bah|like i mean|you know|i mean)\b[,]?\s*",
    re.IGNORECASE,
)
_THINK = re.compile(r"<think>.*?</think>\s*", re.DOTALL)


class Polisher:
    # Loading a 4B model onto the GPU on first request is far slower than
    # any subsequent one, so the cold path gets its own budget.
    cold_timeout_s = 120.0

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._llm_ok: bool | None = None

    # -- public ------------------------------------------------------------
    def available(self) -> bool:
        """Probe the Ollama server once and cache the answer."""
        if self.cfg.polish_backend != "ollama":
            return False
        if self._llm_ok is None:
            try:
                with urllib.request.urlopen(
                    f"{self.cfg.ollama_url}/api/tags", timeout=1.5
                ) as resp:
                    tags = json.load(resp)
                names = {m["name"] for m in tags.get("models", [])}
                self._llm_ok = any(
                    n == self.cfg.polish_model
                    or n.split(":")[0] == self.cfg.polish_model.split(":")[0]
                    for n in names
                )
                if not self._llm_ok:
                    _log.warning(
                        "ollama is up but %s is not pulled; using rules "
                        "(run: ollama pull %s)",
                        self.cfg.polish_model, self.cfg.polish_model,
                    )
            except Exception:
                _log.warning("ollama unreachable at %s; using rules",
                             self.cfg.ollama_url)
                self._llm_ok = False
        return self._llm_ok

    def warmup(self) -> None:
        """Force the model into VRAM so the first dictation is not slow.

        Never fatal: cleanup is an enhancement, and dictation must still
        start if the LLM is missing, cold, or wedged.
        """
        if not self.available():
            return
        t0 = time.perf_counter()
        try:
            # A cold Ollama model has to be read off disk and loaded onto the
            # GPU, which takes far longer than any steady-state request.
            self._ollama("Hello there.", language=None, timeout=self.cold_timeout_s)
        except Exception as exc:
            _log.warning(
                "llm warmup failed (%s); cleanup will fall back to rules "
                "until it responds", exc,
            )
            self._llm_ok = None  # re-probe on first real use
            return
        _log.info("llm warmup %.0fms", (time.perf_counter() - t0) * 1000)

    def polish(self, text: str, language: str | None = None) -> tuple[str, float]:
        """Return (cleaned_text, elapsed_seconds)."""
        if not text.strip() or self.cfg.polish_backend == "off":
            return text, 0.0
        t0 = time.perf_counter()
        if self.available():
            try:
                out = self._finish(self._ollama(text, language))
                if self._plausible(out, text):
                    elapsed = time.perf_counter() - t0
                    _log.info("llm %.0fms", elapsed * 1000)
                    return out, elapsed
            except Exception as exc:
                _log.warning("llm failed (%s); falling back to rules", exc)
                self._llm_ok = None  # re-probe next time
        return self._rules(text), time.perf_counter() - t0

    @staticmethod
    def _finish(text: str) -> str:
        """Enforce what a small model is unreliable about.

        A 3B model gets capitalisation and the final full stop right maybe
        four times in five. Those are mechanical rules, so apply them in
        code instead of spending prompt tokens and latency begging for them.
        """
        out = text.strip()
        if not out:
            return out
        # Leave list items and code alone - the first character is markup.
        if out[0] in "-*#`0123456789":
            return out
        if out[0].islower():
            out = out[0].upper() + out[1:]
        if out[-1] not in ".!?:,;…\"')]":
            out += "."
        return out

    @staticmethod
    def _plausible(out: str, source: str) -> bool:
        """Reject output that clearly is not a cleaned-up transcript.

        Cleanup should return roughly what was said. A reasoning model that
        ignores its instructions will happily emit several paragraphs of
        analysis, and pasting that into the user's document is far worse
        than pasting the raw transcript.
        """
        if not out:
            _log.warning("llm returned nothing; using rules")
            return False
        # Cleanup removes fillers, so growth is the suspicious direction.
        budget = max(120, int(len(source) * 1.6))
        if len(out) > budget:
            _log.warning(
                "llm returned %d chars for %d in; treating as rambling and "
                "using rules instead", len(out), len(source),
            )
            return False
        return True

    # -- backends ----------------------------------------------------------
    def _ollama(
        self, text: str, language: str | None, timeout: float | None = None
    ) -> str:
        hint = f"\n\nThe speaker's language is: {language}." if language else ""
        payload = {
            "model": self.cfg.polish_model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT + hint},
                {"role": "user", "content": text},
            ],
            "stream": False,
            "think": False,  # Qwen3 et al. reason by default; we want latency
            "options": {"temperature": 0.1, "num_predict": 512},
        }
        req = urllib.request.Request(
            f"{self.cfg.ollama_url}/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(
            req, timeout=timeout or self.cfg.polish_timeout_s
        ) as resp:
            body = json.load(resp)
        out = body.get("message", {}).get("content", "").strip()
        out = _THINK.sub("", out).strip()
        return out.strip('"')

    @staticmethod
    def _rules(text: str) -> str:
        out = _FILLERS.sub("", text).strip()
        out = re.sub(r"\s+", " ", out)
        out = re.sub(r"\s+([,.!?;:])", r"\1", out)
        if out:
            out = out[0].upper() + out[1:]
            if out[-1] not in ".!?:,\u2026":
                out += "."
        return out
