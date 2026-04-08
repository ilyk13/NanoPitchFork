#!/usr/bin/env python3
"""
Rebuild LEADERBOARD.md from all JSON files in the results/ directory.

Usage:
    python scripts/update_leaderboard.py
    python scripts/update_leaderboard.py --results-dir results --output LEADERBOARD.md
"""

import argparse
import json
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Primary sort key: realtime RPA at clean condition (most informative for students).
# Adjust if evaluate.py uses different top-level keys.
SORT_KEY = "rpa_realtime_clean"
SORT_KEY_FALLBACK = "rpa_realtime"   # if per-SNR breakdown not available


def extract_primary_metric(metrics: dict) -> float:
    """Pull the single number used for ranking."""
    # Try clean-condition realtime RPA first.
    for key in (SORT_KEY, SORT_KEY_FALLBACK, "rpa", "rpa_offline_clean", "rpa_offline"):
        if key in metrics and metrics[key] is not None:
            return float(metrics[key])
    # Fall back to any float value that looks like an accuracy.
    for k, v in metrics.items():
        if "rpa" in k.lower() and isinstance(v, (int, float)):
            return float(v)
    return 0.0


def format_pct(v) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v)*100:.1f}%"
    except (TypeError, ValueError):
        return str(v)


def format_cents(v) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):.1f}¢"
    except (TypeError, ValueError):
        return str(v)


def build_table(entries: list[dict]) -> str:
    """Return a GitHub-flavored Markdown table."""

    # Columns we want to show (label, key in JSON, formatter)
    # Adapt these keys to match what evaluate.py actually outputs.
    columns = [
        ("Rank",               None,                        None),
        ("Student",            "student_name",              None),
        ("RPA Clean ↑",        "rpa_realtime_clean",        format_pct),
        ("RPA 0 dB ↑",         "rpa_realtime_0db",          format_pct),
        ("RPA -5 dB ↑",        "rpa_realtime_-5db",         format_pct),
        ("VAD Acc ↑",          "vad_accuracy",              format_pct),
        ("Median Err ↓",       "median_cent_error",         format_cents),
        ("Note",               "note",                      None),
    ]

    header = "| " + " | ".join(label for label, _, _ in columns) + " |"
    sep    = "| " + " | ".join("---" for _ in columns) + " |"
    rows   = [header, sep]

    for rank, m in enumerate(entries, start=1):
        cells = []
        for label, key, fmt in columns:
            if key is None:
                cells.append(str(rank))
            else:
                val = m.get(key)
                if fmt:
                    cells.append(fmt(val))
                else:
                    cells.append(str(val) if val is not None else "—")
        rows.append("| " + " | ".join(cells) + " |")

    return "\n".join(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-dir", default="results",
                        help="Directory containing per-student JSON result files")
    parser.add_argument("--output", default="LEADERBOARD.md",
                        help="Output Markdown file path")
    args = parser.parse_args()

    results_dir = Path(args.results_dir)
    output_path = Path(args.output)

    # --- Collect and rank all entries ---
    entries = []
    for json_path in sorted(results_dir.glob("*.json")):
        try:
            with open(json_path) as f:
                m = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: could not load {json_path}: {e}")
            continue
        m["_sort"] = extract_primary_metric(m)
        m["_file"] = json_path.name
        entries.append(m)

    entries.sort(key=lambda m: m["_sort"], reverse=True)

    # --- Render Markdown ---
    today = date.today().isoformat()

    if entries:
        table = build_table(entries)
    else:
        table = "_No submissions yet._"

    content = f"""# NanoPitch Student Leaderboard

Ranked by **Realtime RPA (clean condition)** — Raw Pitch Accuracy of the streaming Viterbi decoder on clean audio.

> **Higher is better** for RPA and VAD Accuracy.  **Lower is better** for Median Cent Error.

*Last updated: {today}*

## Results

{table}

---

## Metrics glossary

| Metric | Description |
|--------|-------------|
| RPA | Raw Pitch Accuracy — % of voiced frames within 50 cents of ground truth |
| VAD Acc | Voice Activity Detection accuracy — % of frames correctly classified as voiced/unvoiced |
| Median Err | Median pitch error in cents across all voiced frames (100 cents = 1 semitone) |

Evaluation uses the **realtime Viterbi decoder**, which matches the browser deployment (no lookahead).
"""

    output_path.write_text(content)
    print(f"Leaderboard written to {output_path} ({len(entries)} entries).")


if __name__ == "__main__":
    main()
