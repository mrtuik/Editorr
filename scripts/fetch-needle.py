#!/usr/bin/env python3
"""Fetches the Cactus needle engine for Android arm64 (libneedle.a + needle.h) into native/android/third_party/needle.
Whistle (speech to text for captions) runs on this engine. Needs: pip install cactus-needle huggingface_hub
Fails loudly when the engine or the speech API is missing, so a build can never ship with captions silently broken."""
import pathlib, re, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / "native/android/third_party/needle"
DEST.mkdir(parents=True, exist_ok=True)


def find(base: pathlib.Path):
    lib = next(iter(base.rglob("libneedle.a")), None)
    hdr = next(iter(base.rglob("needle.h")), None)
    return lib, hdr


def via_hub(tmp: pathlib.Path):
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id="Cactus-Compute/needle3", allow_patterns=["android-arm64/*"], local_dir=str(tmp))
    except Exception as e:  # noqa: BLE001
        print("huggingface_hub download failed:", e)


def via_cli(tmp: pathlib.Path):
    try:
        subprocess.run(["needle", "download", "android-arm64", "--out", str(tmp)], check=True)
    except Exception as e:  # noqa: BLE001
        print("needle CLI download failed:", e)


tmp = pathlib.Path(tempfile.mkdtemp())
via_hub(tmp)
lib, hdr = find(tmp)
if not (lib and hdr):
    via_cli(tmp)
    lib, hdr = find(tmp)
if not (lib and hdr):
    sys.exit("needle engine (libneedle.a + needle.h for android-arm64) could not be downloaded")

shutil.copy2(lib, DEST / "libneedle.a")
shutil.copy2(hdr, DEST / "needle.h")
text = (DEST / "needle.h").read_text(errors="replace")
print("---- needle.h speech API ----")
for m in re.finditer(r"[^;{}]*needle_(?:load|transcribe|last_error)\s*\([^;]*;", text):
    print(" ".join(m.group(0).split()))
if "needle_transcribe" not in text:
    sys.exit("this needle.h has no needle_transcribe: the engine is too old for Whistle")
print("ok:", (DEST / "libneedle.a").stat().st_size, "bytes libneedle.a")
