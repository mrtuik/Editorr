#!/usr/bin/env python3
"""Fetches the Cactus needle engine for Android arm64 (libneedle.a + needle.h) into native/android/third_party/needle.
Whistle (speech to text for captions) runs on this engine. Needs: pip install cactus-needle huggingface_hub
Tries, in order: `needle download android-arm64 --generation 3`, `needle download android-arm64`, then a search of the
Hugging Face repos for any android/arm64 folder or archive. Prints what it saw, and fails loudly if nothing works."""
import pathlib, re, shutil, subprocess, sys, tarfile, tempfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / "native/android/third_party/needle"
DEST.mkdir(parents=True, exist_ok=True)
REPOS = ["Cactus-Compute/needle3", "Cactus-Compute/whistle", "Cactus-Compute/needle2"]


def find(base: pathlib.Path):
    """An android arm64 libneedle.a with a needle.h that has the speech API (Needle 2 engines do not)."""
    for lib in base.rglob("libneedle.a"):
        s = str(lib).lower()
        if "android" not in s or "arm64" not in s:
            continue
        hdr = lib.with_name("needle.h")
        if hdr.exists() and "needle_transcribe" in hdr.read_text(errors="replace"):
            return lib, hdr
    return None, None


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


def direct(tmp: pathlib.Path):
    """Plain HTTPS download of android-arm64/libneedle.a + needle.h from Cactus-Compute/needle3 (no pip, no CLI needed).
    This is the folder the Whistle model card points to; the files are served through Hugging Face's LFS redirect."""
    import urllib.request
    base = "https://huggingface.co/Cactus-Compute/needle3/resolve/main/android-arm64/"
    out = tmp / "direct" / "android-arm64"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("libneedle.a", "needle.h"):
        for attempt in range(1, 4):
            try:
                req = urllib.request.Request(base + name, headers={"User-Agent": "editorr-ci"})
                with urllib.request.urlopen(req, timeout=120) as r, open(out / name, "wb") as f:
                    shutil.copyfileobj(r, f)
                print(f"direct: got {name} ({(out / name).stat().st_size} bytes)")
                break
            except Exception as e:  # noqa: BLE001
                print(f"direct: {name} attempt {attempt} failed: {e}")
        else:
            return
    magic = (out / "libneedle.a").read_bytes()[:8]
    if magic != b"!<arch>\n":
        print("direct: libneedle.a is not a static archive (got %r): probably an LFS pointer or an error page" % magic)
        (out / "libneedle.a").unlink()


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


def releases(tmp: pathlib.Path):
    """GitHub release assets of cactus-compute/needle (the repo README says engines come from the release)."""
    import json, urllib.request
    try:
        data = json.load(urllib.request.urlopen("https://api.github.com/repos/cactus-compute/needle/releases?per_page=10", timeout=30))
    except Exception as e:  # noqa: BLE001
        print("cannot read GitHub releases:", e)
        return
    for rel in data:
        names = [a["name"] for a in rel.get("assets", [])]
        print("---- release", rel.get("tag_name"), names)
        for a in rel.get("assets", []):
            n = a["name"].lower()
            if "android" in n and "arm64" in n:
                dst = tmp / "release" / a["name"]
                dst.parent.mkdir(parents=True, exist_ok=True)
                try:
                    urllib.request.urlretrieve(a["browser_download_url"], dst)
                    unpack(dst, tmp / "unpacked" / dst.name)
                    if dst.suffix == ".a" or dst.name == "needle.h":
                        pass
                except Exception as e:  # noqa: BLE001
                    print("download failed", a["name"], e)


def package_repos(tmp: pathlib.Path):
    """Asks the installed cactus-needle which repos hold its engines, lists them and looks for an android arm64 engine with the speech API."""
    try:
        import needle.agent.fetch as fetch
        from huggingface_hub import HfApi, hf_hub_download
    except Exception as e:  # noqa: BLE001
        print("package_repos unavailable:", e)
        return
    repos = set()
    er = getattr(fetch, "ENGINE_REPOS", None)
    if isinstance(er, dict):
        repos.update(v for v in er.values() if isinstance(v, str))
    elif isinstance(er, (list, tuple)):
        repos.update(v for v in er if isinstance(v, str))
    print("engine repos named by the package:", sorted(repos))
    api = HfApi()
    for repo in sorted(repos):
        try:
            files = api.list_repo_files(repo)
        except Exception as e:  # noqa: BLE001
            print("cannot list", repo, e)
            continue
        hits = [f for f in files if re.search(r"android|wasm|libneedle|\.whl$", f, re.I)]
        print(f"---- {repo}: {len(files)} files, {len(hits)} engine-like ----")
        for f in hits[:80]:
            print("  ", f)
        for f in hits:
            if "android" in f.lower() and "arm64" in f.lower() and f.endswith((".a", ".h")):
                try:
                    hf_hub_download(repo, f, local_dir=str(tmp / "pkg" / repo.replace("/", "_")))
                except Exception as e:  # noqa: BLE001
                    print("download failed", f, e)


def introspect():
    """Shows where the installed cactus-needle package gets its engines from, to fix the search above."""
    try:
        import needle.agent.fetch as fetch
        src = pathlib.Path(fetch.__file__).read_text(errors="replace")
        print("---- needle/agent/fetch.py, top and engine layout ----")
        lines = src.splitlines()
        for i in list(range(0, 60)) + list(range(250, 270)):
            if i < len(lines):
                print(f"{i + 1}: {lines[i][:200]}")
    except Exception as e:  # noqa: BLE001
        print("cannot read needle.agent.fetch:", e)


tmp = pathlib.Path(tempfile.mkdtemp())
lib = hdr = None
# A copy committed to the repo wins: put libneedle.a + needle.h (from Cactus-Compute/needle3/android-arm64) in native/android/third_party/needle.
if (DEST / "libneedle.a").exists() and (DEST / "needle.h").exists() and "needle_transcribe" in (DEST / "needle.h").read_text(errors="replace"):
    print("engine already present in", DEST, "- nothing to download")
    sys.exit(0)
direct(tmp)
lib, hdr = find(tmp)
for extra in (() if (lib and hdr) else (("--generation", "3"), ())):
    cli(tmp, *extra)
    lib, hdr = find(tmp)
    if lib and hdr:
        break
if not (lib and hdr):
    hub(tmp)
    lib, hdr = find(tmp)
if not (lib and hdr):
    package_repos(tmp)
    lib, hdr = find(tmp)
if not (lib and hdr):
    releases(tmp)
    lib, hdr = find(tmp)
if not (lib and hdr):
    introspect()
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
