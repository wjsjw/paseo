#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
web_dist="$repo_root/packages/app/dist"
output="$repo_root/packages/intellij/build/distributions/paseo-intellij-0.1.2.zip"
host_plugin_dir="${PASEO_JCEF_HOST_PLUGIN_DIR:-$HOME/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/paseo-intellij}"
host_jar="${PASEO_JCEF_HOST_JAR:-$host_plugin_dir/lib/paseo-intellij-0.1.2.jar}"
if [[ ! -f "$host_jar" && -z "${PASEO_JCEF_HOST_JAR:-}" ]]; then
  host_jar="$HOME/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/paseo-intellij-jcef-preview/lib/paseo-intellij-0.1.1.jar"
fi
idea_contents="${IDEA_HOME:-/Applications/IntelliJ IDEA.app/Contents}"
if [[ -d "$idea_contents/Contents/lib" ]]; then
  idea_contents="$idea_contents/Contents"
fi
java_home="${JAVA_HOME:-$idea_contents/jbr/Contents/Home}"
asm_jar="${PASEO_INTELLIJ_ASM_JAR:-$idea_contents/lib/intellij.libraries.asm.jar}"
gson_jar="${PASEO_JCEF_GSON_JAR:-$(dirname "$host_jar")/gson-2.13.2.jar}"

for required in "$host_jar" "$web_dist/index.html" "$asm_jar" "$gson_jar" \
  "$java_home/bin/java" "$java_home/bin/javac" \
  "$script_dir/PatchJcefBridge.java" \
  "$repo_root/packages/intellij/src/main/java/sh/paseo/intellij/PaseoLocalCredentialBridge.java" \
  "$repo_root/packages/intellij/src/test/java/sh/paseo/intellij/PaseoLocalCredentialBridgeTest.java"; do
  if [[ ! -f "$required" ]]; then
    printf 'Required input not found: %s\n' "$required" >&2
    printf 'Set PASEO_JCEF_HOST_JAR to the JCEF host plugin JAR if needed.\n' >&2
    exit 1
  fi
done

command -v unzip >/dev/null || { echo 'unzip is required.' >&2; exit 1; }
command -v zip >/dev/null || { echo 'zip is required.' >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/host" "$stage/plugin/paseo-intellij/lib" "$repo_root/packages/intellij/build/distributions"
unzip -q "$host_jar" -d "$stage/host"

# Compile and test the credential command, then add it to the existing host's dispatcher.
mkdir -p "$stage/tool-classes" "$stage/test-classes"
"$java_home/bin/javac" -cp "$gson_jar" -d "$stage/host" \
  "$repo_root/packages/intellij/src/main/java/sh/paseo/intellij/PaseoLocalCredentialBridge.java"
"$java_home/bin/javac" -cp "$gson_jar:$stage/host" -d "$stage/test-classes" \
  "$repo_root/packages/intellij/src/test/java/sh/paseo/intellij/PaseoLocalCredentialBridgeTest.java"
"$java_home/bin/java" -ea -cp "$gson_jar:$stage/host:$stage/test-classes" \
  sh.paseo.intellij.PaseoLocalCredentialBridgeTest
"$java_home/bin/javac" -cp "$asm_jar" -d "$stage/tool-classes" \
  "$script_dir/PatchJcefBridge.java"
"$java_home/bin/java" -cp "$asm_jar:$stage/tool-classes" PatchJcefBridge \
  "$stage/host/sh/paseo/intellij/PaseoWebview.class" \
  "$stage/host/sh/paseo/intellij/PaseoWebServer.class"

# Use the freshly exported Paseo 0.15.0 web UI while preserving the JCEF host
# bootstrap, IDE bridge, and viewport events.
bootstrap="$stage/host/web/webview-bootstrap.js"
if [[ ! -f "$bootstrap" ]]; then
  echo 'The selected JCEF host JAR does not contain webview-bootstrap.js.' >&2
  exit 1
fi
cp "$bootstrap" "$stage/webview-bootstrap.js"
rm -rf "$stage/host/web"
mkdir -p "$stage/host/web"
cp -R "$web_dist"/. "$stage/host/web/"
cp "$stage/webview-bootstrap.js" "$stage/host/web/webview-bootstrap.js"

python3 - "$stage/host/META-INF/plugin.xml" "$stage/host/sh/paseo/intellij/AddSelectionToChatAction.class" <<'PY'
from pathlib import Path
import re
import sys

xml_path = Path(sys.argv[1])
xml = xml_path.read_text()
if '<id>sh.paseo.intellij.jcef-preview</id>' in xml:
    xml = xml.replace('<id>sh.paseo.intellij.jcef-preview</id>', '<id>sh.paseo</id>', 1)
if '<id>sh.paseo</id>' not in xml:
    raise SystemExit('The JCEF host plugin ID is not sh.paseo.')
xml = xml.replace('<name>Paseo (JCEF preview)</name>', '<name>Paseo</name>', 1)
xml = re.sub(r'<version>[^<]+</version>', '<version>0.1.2</version>', xml, count=1)
xml = xml.replace('<toolWindow id="Paseo JCEF preview"', '<toolWindow id="Paseo"', 1)
xml = xml.replace('id="Paseo.JcefPreview.AddSelectionToChat"', 'id="Paseo.AddSelectionToChat"', 1)
xml_path.write_text(xml)

# Older preview builds used a separate tool-window label. Current release builds
# already use "Paseo", so only patch the preview string when it is present.
class_path = Path(sys.argv[2])
data = bytearray(class_path.read_bytes())
if data[:4] != bytes.fromhex("cafebabe"):
    raise SystemExit("Unexpected AddSelectionToChatAction class file")
constant_count = int.from_bytes(data[8:10], "big")
offset = 10
index = 1
patched = False
found_main_label = False
while index < constant_count:
    tag = data[offset]
    offset += 1
    if tag == 1:
        length = int.from_bytes(data[offset:offset + 2], "big")
        start = offset + 2
        end = start + length
        if data[start:end] == b"Paseo JCEF preview":
            replacement = b"Paseo"
            data[offset:offset + 2] = len(replacement).to_bytes(2, "big")
            data[start:end] = replacement
            offset = start + len(replacement)
            patched = True
        else:
            if data[start:end] == b"Paseo":
                found_main_label = True
            offset = end
    elif tag in {3, 4, 9, 10, 11, 12, 17, 18}:
        offset += 4
    elif tag in {5, 6}:
        offset += 8
        index += 1
    elif tag in {7, 8, 16, 19, 20}:
        offset += 2
    elif tag == 15:
        offset += 3
    else:
        raise SystemExit(f"Unknown class constant-pool tag: {tag}")
    index += 1
if not patched and not found_main_label:
    raise SystemExit("Could not locate the tool-window label in the action class")
if patched:
    class_path.write_bytes(data)
PY

host_name="$(basename "$host_jar")"
cp "$host_jar" "$stage/plugin/paseo-intellij/lib/paseo-intellij-0.1.2.jar"
for dependency in "$(dirname "$host_jar")"/*.jar; do
  [[ -f "$dependency" ]] || continue
  [[ "$(basename "$dependency")" == "$host_name" ]] && continue
  cp "$dependency" "$stage/plugin/paseo-intellij/lib/"
done

# Rebuild the host JAR with the updated metadata, tool-window label, and UI.
rm -f "$stage/plugin/paseo-intellij/lib/paseo-intellij-0.1.2.jar"
(
  cd "$stage/host"
  zip -X -qr "$stage/plugin/paseo-intellij/lib/paseo-intellij-0.1.2.jar" .
)
(
  cd "$stage/plugin"
  zip -X -qr "$output" paseo-intellij
)
printf 'Built %s\n' "$output"
ls -lh "$output"
