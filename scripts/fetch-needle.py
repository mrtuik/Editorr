#!/usr/bin/env python3
"""Fetches the Cactus needle engine for Android arm64 (libneedle.a + needle.h) into native/android/third_party/needle.
Whistle (speech to text for captions) runs on this engine. Needs: pip install cactus-needle huggingface_hub
Tries, in order: `needle download android-arm64 --generation 3`, `needle download android-arm64`, then a search of the
Hugging Face repos for any android/arm64 folder or archive. Prints what it saw, and fails loudly if nothing works."""
import pathlib, re, shutil, subprocess, sys, tarfile, tempfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / "native/android/third_party/needle"
DEST.mkdir(parents=True, exist_ok=True)
REPOS = ["Cactus-Compute/needle3", "Cactus-Compute/needle2", "Cactus-Compute/whistle"]


def find(base: pathlib.Path):
    libs = [p for p in base.rglob("libneedle.a") if "android" in str(p).lower() and "arm64" in str(p).lower()] or list(base.rglob("libneedle.a"))
    hdrs = [p for p in base.rglob("needle.h") if "android" in str(p).lower()] or list(base.rglob("needle.h"))
    return (libs[0] if libs else None), (hdrs[0] if hdrs else None)


def unpack(f: pathlib.Path, out: pathlib.Path):
    out.mkdir(parents=True, exist_ok=True)
    n = f.name.lower()
    try:
        if n.endswith((".zip", ".whl")):
            zipfile.ZipFile(f).extractall(out)
        elif n.endswith((".tar.gz", ".tgz", ".tar")):
            tarfile.open(f).extractall(out)
    except Exception as e:  # noqa: BLE001
        print("could not unpack", f, e)


def cli(tmp: pathlib.Path, *extra):
    cmd = ["needle", "download", "android-arm64", "--out", str(tmp), *extra]
    print("running:", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    print((r.stdout + r.stderr).strip()[-600:])


def hub(tmp: pathlib.Path):
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except Exception as e:  # noqa: BLE001
        print("huggingface_hub missing:", e)
        return
    api = HfApi()
    for repo in REPOS:
        try:
            files = api.list_repo_files(repo)
        except Exception as e:  # noqa: BLE001
            print("cannot list", repo, e)
            continue
        print(f"---- {repo}: {len(files)} files ----")
        for f in files[:150]:
            print("  ", f)
        want = [f for f in files if "android" in f.lower() and "arm64" in f.lower()]
        for f in want:
            try:
                p = pathlib.Path(hf_hub_download(repo, f, local_dir=str(tmp / repo.replace("/", "_"))))
                unpack(p, tmp / "unpacked" / p.name)
            except Exception as e:  # noqa: BLE001
                print("download failed", f, e)
        lib, hdr = find(tmp)
        if lib and hdr:
            return


tmp = pathlib.Path(tempfile.mkdtemp())
lib = hdr = None
for extra in (("--generation", "3"), ()):
    cli(tmp, *extra)
    lib, hdr = find(tmp)
    if lib and hdr:
        break
if not (lib and hdr):
    hub(tmp)
    lib, hdr = find(tmp)
if not (lib and hdr):
    sys.exit("needle engine (libneedle.a + needle.h for android-arm64) could not be found: see the file lists above")

shutil.copy2(lib, DEST / "libneedle.a")
shutil.copy2(hdr, DEST / "needle.h")
text = (DEST / "needle.h").read_text(errors="replace")
print("---- needle.h speech API ----")
for m in re.finditer(r"[^;{}]*needle_(?:load|transcribe|last_error)\s*\([^;]*;", text):
    print(" ".join(m.group(0).split()))
if "needle_transcribe" not in text:
    sys.exit("this needle.h has no needle_transcribe: the engine is too old for Whistle")
print("ok:", (DEST / "libneedle.a").stat().st_size, "bytes libneedle.a from", lib)
