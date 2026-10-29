#!/usr/bin/env python3
"""Patch the Capacitor-generated android/ project for Editorr.

Run after `npx cap add android`. Safe to run more than once.
"""
import os
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

# 1b. Optional YouTube module. real code by default; only EDITORR_YOUTUBE=0 gives the empty stub.
yt_on = os.environ.get("EDITORR_YOUTUBE", "1") != "0"
shutil.copy(ROOT / "native/android/youtube" / ("real" if yt_on else "stub") / "YouTubeBridge.java", pkg_dir / "YouTubeBridge.java")
print("YouTube module:", "ON" if yt_on else "off (stub)")

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
    '<uses-permission android:name="android.permission.INTERNET" />',
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
    # version numbers from CI (fall back to 1 / 16.3.1 for local builds)
    txt = re.sub(r"versionCode\s+\d+", "versionCode Integer.parseInt(System.getenv('VERSION_CODE') ?: '1')", txt, count=1)
    txt = re.sub(r'versionName\s+"[^"]*"', "versionName System.getenv('VERSION_NAME') ?: '16.3.1'", txt, count=1)
    app_gradle.write_text(txt)


# 5b. Android 11+ hides other apps unless they are listed: needed to open Instagram / WhatsApp / TikTok... directly from "Saved to device".
txt = manifest.read_text()
if "<queries>" not in txt:
    pkgs = ["com.instagram.android", "com.google.android.youtube", "com.whatsapp", "com.whatsapp.w4b",
            "com.facebook.katana", "com.zhiliaoapp.musically", "com.ss.android.ugc.trill",
            ]
    q = "    <queries>\n" + "".join(f'        <package android:name="{x}" />\n' for x in pkgs) + "    </queries>\n\n    "
    txt = txt.replace("<application", q + "<application", 1)
    manifest.write_text(txt)

# 5c. Dark status bar + navigation bar from the very first frame (no grey / white flash before MainActivity runs).
styles = ANDROID / "app/src/main/res/values/styles.xml"
if styles.exists():
    txt = styles.read_text()
    if "navigationBarColor" not in txt:
        items = (
            '        <item name="android:statusBarColor">#141416</item>\n'
            '        <item name="android:navigationBarColor">#141416</item>\n'
            '        <item name="android:windowLightStatusBar">false</item>\n'
            '        <item name="android:windowLightNavigationBar">false</item>\n'
        )
        txt = re.sub(r'(<style name="AppTheme\.NoActionBar"[^>]*>\n)', lambda m: m.group(1) + items, txt, count=1)
        txt = re.sub(r'(<style name="AppTheme\.NoActionBarLaunch"[^>]*>\n)', lambda m: m.group(1) + items, txt, count=1)
        styles.write_text(txt)

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


# 6. Built-in Antigravity (Google's official CLI inside a private PRoot Linux). No other app needed.
agy_on = (ROOT / "native/android/agy").exists()
if agy_on:
    base_url = os.environ.get("EDITORR_RUNTIME_BASE_URL", "https://github.com/techjarves/Mobile-Harness/releases/download/runtime-2026.09.4")
    target_sdk = os.environ.get("EDITORR_TARGET_SDK", "28")
    agy_dir = ANDROID / "app/src/main/java/com/tuik/editorr/agy"
    agy_dir.mkdir(parents=True, exist_ok=True)
    for f in (ROOT / "native/android/agy").glob("*.java"):
        t = f.read_text().replace("@RUNTIME_BASE_URL@", base_url)
        (agy_dir / f.name).write_text(t)
    cpp_dest = ANDROID / "app/src/main/cpp"
    shutil.copytree(ROOT / "native/android/cpp", cpp_dest, dirs_exist_ok=True)
    tp_src = ROOT / "native/android/third_party"
    tp_dest = ANDROID / "app/third_party"
    if tp_dest.exists():
        shutil.rmtree(tp_dest)
    shutil.copytree(tp_src, tp_dest, ignore=shutil.ignore_patterns(".git", "samples", "bindings", "models"))
    if not (tp_dest / "proot/src/cli/proot.c").exists():
        sys.exit("PRoot sources missing: run the 'Fetch native sources' step (git clone termux/proot into native/android/third_party/proot)")

    txt = app_gradle.read_text()
    if "externalNativeBuild" not in txt:
        block = (
            "    ndkVersion '26.1.10909125'\n"
            "    externalNativeBuild {\n"
            "        cmake {\n"
            "            path file('src/main/cpp/CMakeLists.txt')\n"
            "            version '3.22.1'\n"
            "        }\n"
            "    }\n"
            "    packagingOptions {\n"
            "        jniLibs {\n"
            "            useLegacyPackaging = true\n"
            "        }\n"
            "    }\n"
            "    lint {\n"
            "        abortOnError false\n"
            "        checkReleaseBuilds false\n"
            "    }\n"
        )
        txt = re.sub(r"(\nandroid\s*\{\n)", lambda m: m.group(1) + block, txt, count=1)
        # arm64 only: PRoot is built for arm64-v8a
        txt = re.sub(r"(defaultConfig\s*\{\n)", lambda m: m.group(1) + "        ndk { abiFilters 'arm64-v8a' }\n", txt, count=1)
        txt = re.sub(r"(dependencies\s*\{\n)", lambda m: m.group(1) +
                     "    implementation 'org.apache.commons:commons-compress:1.27.1'\n"
                     "    implementation 'com.github.luben:zstd-jni:1.5.6-9@aar'\n", txt, count=1)
        app_gradle.write_text(txt)

    # PRoot needs targetSdk 28 to run Linux programs from app storage (Android blocks it for newer targets).
    vtxt = vars_gradle.read_text()
    vtxt = re.sub(r"targetSdkVersion\s*=\s*\d+", f"targetSdkVersion = {target_sdk}", vtxt)
    vars_gradle.write_text(vtxt)
    print("Antigravity runtime: ON (targetSdk %s, arm64 only)" % target_sdk)
