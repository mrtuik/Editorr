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


# Cactus removed the platform folders from the *main* branch of Cactus-Compute/needle3 (CI log: main has only 8 files, no android-arm64).
# Older commits still hold them, so the engine is taken from a pinned commit. Both ids were seen listing android-arm64/libneedle.a + needle.h.
PINNED = [
    "d6c7d6a2e9655505e0f8e23339356dd1705900eb",  # engine whose needle.h declares needle_transcribe (checked by another project's CI, 2026-10-20)
    "b009f8937124b2d0458f4ed040c10c41fd2a0dfc",
    "93e88ede867e4311c39151285e74df513e4b835b",
]


def _get(url: str, dst: pathlib.Path) -> bool:
    import urllib.request
    for attempt in range(1, 3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "editorr-ci"})
            with urllib.request.urlopen(req, timeout=120) as r, open(dst, "wb") as f:
                shutil.copyfileobj(r, f)
            return True
        except Exception as e:  # noqa: BLE001
            print(f"  {url.split('/resolve/')[-1]} attempt {attempt} failed: {e}")
    return False


def _try_revision(tmp: pathlib.Path, rev: str) -> bool:
    out = tmp / "direct" / rev[:8] / "android-arm64"
    out.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/Cactus-Compute/needle3/resolve/{rev}/android-arm64/"
    for name in ("libneedle.a", "needle.h"):
        if not _get(base + name, out / name):
            return False
    ok = (out / "libneedle.a").read_bytes()[:8] == b"!<arch>\n" and "needle_transcribe" in (out / "needle.h").read_text(errors="replace")
    print(f"revision {rev[:8]}: libneedle.a {(out / 'libneedle.a').stat().st_size} bytes, speech API {'yes' if ok else 'NO'}")
    return ok


def direct(tmp: pathlib.Path):
    """Plain HTTPS download of android-arm64/libneedle.a + needle.h from a pinned commit of Cactus-Compute/needle3."""
    for rev in PINNED:
        print("trying needle3 revision", rev)
        if _try_revision(tmp, rev):
            return


def history(tmp: pathlib.Path):
    """Walks the commit history of needle3 (and its branches/tags) for any commit that still has android-arm64/libneedle.a."""
    try:
        from huggingface_hub import HfApi
    except Exception as e:  # noqa: BLE001
        print("huggingface_hub missing:", e)
        return
    api = HfApi()
    repo = "Cactus-Compute/needle3"
    revs = []
    try:
        refs = api.list_repo_refs(repo)
        revs += [b.target_commit for b in refs.branches] + [t.target_commit for t in refs.tags]
    except Exception as e:  # noqa: BLE001
        print("cannot list refs:", e)
    try:
        revs += [c.commit_id for c in api.list_repo_commits(repo)][:120]
    except Exception as e:  # noqa: BLE001
        print("cannot list commits:", e)
    seen = set(PINNED)
    for rev in revs:
        if not rev or rev in seen:
            continue
        seen.add(rev)
        try:
            files = api.list_repo_files(repo, revision=rev)
        except Exception as e:  # noqa: BLE001
            continue
        if "android-arm64/libneedle.a" in files and "android-arm64/needle.h" in files:
            print("history: commit", rev, "has android-arm64")
            if _try_revision(tmp, rev):
                return
    print(f"history: looked at {len(seen)} revisions, none had a usable android-arm64 engine")


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
if not (lib and hdr):
    history(tmp)
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
    sys.exit("needle engine (libneedle.a + needle.h for android-arm64) could not be found: see the lines above. Manual fix: download the android-arm64 folder from "
             "https://huggingface.co/Cactus-Compute/needle3/tree/b009f8937124b2d0458f4ed040c10c41fd2a0dfc/android-arm64 and commit libneedle.a + needle.h to native/android/third_party/needle/")

shutil.copy2(lib, DEST / "libneedle.a")
shutil.copy2(hdr, DEST / "needle.h")
text = (DEST / "needle.h").read_text(errors="replace")
print("---- needle.h speech API ----")
for m in re.finditer(r"[^;{}]*needle_(?:load|transcribe|last_error)\s*\([^;]*;", text):
    print(" ".join(m.group(0).split()))
if "needle_transcribe" not in text:
    sys.exit("this needle.h has no needle_transcribe: the engine is too old for Whistle")
print("ok:", (DEST / "libneedle.a").stat().st_size, "bytes libneedle.a from", lib)
