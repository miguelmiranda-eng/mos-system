"""Shared Anthropic (Claude) client + helpers for MOS.

Replaces the Gemini (google-generativeai) usage in the WMS query and the
Spektrum PDF vision reader. Unlike Gemini's free tier (20 req/day per model),
Claude is pay-per-use with no daily quota — see the cost breakdown discussed
with the team.

Key resolution order:
  1. ANTHROPIC_API_KEY env var  (set it in backend/.env — simplest, no UI).
  2. encrypted_anthropic_key in insights_config  (for a future config screen).

Model tiers (price per 1M tokens):
  Haiku 4.5   $1 / $5    -> routing + row summaries  (cheap, fast, no quota)
  Sonnet 4.6  $3 / $15   -> vision / OCR of image-based PDFs  (better reads)
"""
import os
import json
import re

import anthropic

ROUTER_MODEL = "claude-haiku-4-5"    # NL question -> which WMS tool + params
SUMMARY_MODEL = "claude-haiku-4-5"   # real rows   -> short Spanish answer
VISION_MODEL = "claude-sonnet-4-6"   # rendered PDF page -> structured JSON


async def anthropic_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    # Fallback: an encrypted key stored via a config UI (same pattern as Gemini).
    from deps import db
    from cryptography.fernet import Fernet
    config = await db.insights_config.find_one({"config_id": "main"}, {"_id": 0})
    enc = os.environ.get("MOS_ENCRYPTION_KEY")
    if config and config.get("encrypted_anthropic_key") and enc:
        return Fernet(enc.encode()).decrypt(config["encrypted_anthropic_key"].encode()).decode()
    raise RuntimeError("Falta ANTHROPIC_API_KEY (agrégala en backend/.env).")


async def get_client() -> "anthropic.AsyncAnthropic":
    return anthropic.AsyncAnthropic(api_key=await anthropic_key())


def json_from_text(txt: str):
    """Parse JSON from a model reply, tolerating ```json fences / surrounding prose."""
    t = (txt or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t).rstrip("`").strip()
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, re.S)
        return json.loads(m.group(0)) if m else None


def text_of(msg) -> str:
    """Concatenate the text blocks of a Claude Messages response."""
    return "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
