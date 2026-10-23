#!/usr/bin/env python3
"""Patch the Capacitor-generated android/ project for Editorr.

Run after `npx cap add android`. Safe to run more than once.
"""
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ANDROID = ROOT / "android"
if not ANDROID.exists():
    sys.exit("android/ not found. Run: npx cap add android")

MEDIA3 = "1.6.1"

# 1. Native sources
pkg_dir = ANDROID / "app/src/main/java/com/tuik/editorr"
pkg_dir.mkdir(parents=True, exist_ok=True)
for f in ("EditorrNativePlugin.java", "MainActivity.java"):
    shutil.copy(ROOT / "native/android" / f, pkg_dir / f)

# 2. minSdk 26
vars_gradle = ANDROID / "variables.gradle"
txt = vars_gradle.read_text()
txt = re.sub(r"minSdkVersion\s*=\s*\d+", "minSdkVersion = 26", txt)
vars_gradle.write_text(txt)

# 2b. Media3 1.6.x needs compileSdk 35, which needs a newer Android Gradle Plugin + Gradle.
txt = vars_gradle.read_text()
txt = re.sub(r"compileSdkVersion\s*=\s*\d+", "compileSdkVersion = 35", txt)
vars_gradle.write_text(txt)

root_gradle = ANDROID / "build.gradle"
txt = root_gradle.read_text()
txt = re.sub(r"com\.android\.tools\.build:gradle:[0-9.]+", "com.android.tools.build:gradle:8.7.3", txt)
root_gradle.write_text(txt)

wrapper = ANDROID / "gradle/wrapper/gradle-wrapper.properties"
txt = wrapper.read_text()
txt = re.sub(r"gradle-[0-9.]+-(all|bin)\.zip", "gradle-8.9-all.zip", txt)
wrapper.write_text(txt)

# 3. Media3 dependencies
app_gradle = ANDROID / "app/build.gradle"
txt = app_gradle.read_text()
if "media3-transformer" not in txt:
    deps = (
        f"    implementation 'androidx.media3:media3-transformer:{MEDIA3}'\n"
        f"    implementation 'androidx.media3:media3-effect:{MEDIA3}'\n"
        f"    implementation 'androidx.media3:media3-common:{MEDIA3}'\n"
    )
    txt = re.sub(r"(dependencies\s*\{\n)", r"\1" + deps.replace("\\", "\\\\"), txt, count=1)
    app_gradle.write_text(txt)

# 4. Permissions
manifest = ANDROID / "app/src/main/AndroidManifest.xml"
txt = manifest.read_text()
perms = [
    '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
    '<uses-permission android:name="android.permission.WAKE_LOCK" />',
]
missing = [p for p in perms if p.split('"')[1] not in txt]
if missing:
    txt = txt.replace("<application", "\n    ".join(missing) + "\n\n    <application", 1)
    manifest.write_text(txt)

# 5. Large heap for big videos
txt = manifest.read_text()
if "largeHeap" not in txt:
    txt = txt.replace("<application", '<application android:largeHeap="true"', 1)
    manifest.write_text(txt)

# 6. Stable signing + version numbers (so a new APK installs as an UPDATE, no uninstall).
#    CI passes KS_FILE, KS_PASS, KS_ALIAS, KEY_PASS, VERSION_CODE, VERSION_NAME as environment variables.
txt = app_gradle.read_text()
if "signingConfigs.editorr" not in txt:
    signing = (
        "    signingConfigs {\n"
        "        editorr {\n"
        "            if (System.getenv('KS_FILE')) {\n"
        "                storeFile file(System.getenv('KS_FILE'))\n"
        "                storePassword System.getenv('KS_PASS')\n"
        "                keyAlias System.getenv('KS_ALIAS')\n"
        "                keyPassword System.getenv('KEY_PASS')\n"
        "            }\n"
        "        }\n"
        "    }\n"
    )
    txt = re.sub(r"(\nandroid\s*\{\n)", lambda m: m.group(1) + signing, txt, count=1)
    use = "signingConfig System.getenv('KS_FILE') ? signingConfigs.editorr : null"
    # release: add signingConfig; debug: create the block if the template has none
    if re.search(r"buildTypes\s*\{[^}]*?debug\s*\{", txt, re.S):
        txt = re.sub(r"(debug\s*\{\n)", lambda m: m.group(1) + "            " + use + "\n", txt, count=1)
    else:
        txt = re.sub(r"(buildTypes\s*\{\n)", lambda m: m.group(1) + "        debug {\n            " + use + "\n        }\n", txt, count=1)
    txt = re.sub(r"(release\s*\{\n)", lambda m: m.group(1) + "            " + use + "\n", txt, count=1)
    # version numbers from CI (fall back to 1 / 0.1.0 for local builds)
    txt = re.sub(r"versionCode\s+\d+", "versionCode Integer.parseInt(System.getenv('VERSION_CODE') ?: '1')", txt, count=1)
    txt = re.sub(r'versionName\s+"[^"]*"', "versionName System.getenv('VERSION_NAME') ?: '0.1.0'", txt, count=1)
    app_gradle.write_text(txt)


# 5b. Android 11+ hides other apps unless they are listed: needed to open Instagram / WhatsApp / TikTok... directly from "Saved to device".
txt = manifest.read_text()
if "<queries>" not in txt:
    pkgs = ["com.instagram.android", "com.google.android.youtube", "com.whatsapp", "com.whatsapp.w4b",
            "com.facebook.katana", "com.zhiliaoapp.musically", "com.ss.android.ugc.trill"]
    q = "    <queries>\n" + "".join(f'        <package android:name="{x}" />\n' for x in pkgs) + "    </queries>\n\n    "
    txt = txt.replace("<application", q + "<application", 1)
    manifest.write_text(txt)

print("Editorr: android project patched")

# 5. App icon (black, no card/oval; adaptive + square + round). Replaces Capacitor's default icons.
icon_res = ROOT / "native/android/res"
if icon_res.exists():
    dest = ANDROID / "app/src/main/res"
    for d in dest.glob("mipmap-*"):
        for f in d.glob("ic_launcher*"):
            f.unlink()
    shutil.copytree(icon_res, dest, dirs_exist_ok=True)
    print("icons installed")
