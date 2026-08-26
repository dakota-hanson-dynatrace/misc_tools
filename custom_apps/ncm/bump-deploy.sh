#!/bin/bash
# dt-app refuses to reinstall a version whose checksum changed, so every deploy
# needs a fresh patch version. Documented trap - see AGENTS.md.
set -e
cd "$(dirname "$0")"
python3 - <<'PY'
import json
p="app.config.json"; d=json.load(open(p))
maj,mi,pa = d["app"]["version"].split(".")
d["app"]["version"] = f"{maj}.{mi}.{int(pa)+1}"
json.dump(d, open(p,"w"), indent=2)
print("version ->", d["app"]["version"])
PY
dt-app deploy 2>&1 | tail -4
