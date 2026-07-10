#!/usr/bin/env bash
# Golden-PR rules probe runner: reviews eval/golden-rule-probe/artifact through the product path in 4 arms
# (baseline / Tier-A rule / Tier-B doc / A+B), N runs each, saving outputs to runs/. Needs a z.ai key.
# Usage: RUNS=3 bash eval/golden-rule-probe/run-arms.sh
set -euo pipefail
P=eval/golden-rule-probe
RUNS="${RUNS:-3}"
KEY="${ZAI_API_KEY:-$(cat ~/.zai_key)}"
mk_arm() { # $1=dir, $2=rule(0/1), $3=doc(0/1)
  local d; d=$(mktemp -d); cp .squarewright.yml "$d/"
  [ "$2" = 1 ] && { mkdir -p "$d/.review-rules"; cp "$P/rules/copy.md" "$d/.review-rules/copy.md"; }
  [ "$3" = 1 ] && { cp "$P/docs/CONVENTIONS.md" "$d/CONVENTIONS.md"; printf '\ncontextDocs:\n  - globs: ["**/*.ts"]\n    path: CONVENTIONS.md\n' >> "$d/.squarewright.yml"; }
  echo "$d"
}
run_arm() { # $1=label, $2=armdir
  for i in $(seq 1 "$RUNS"); do
    local out="$P/runs/$1_$i.json" tries=0
    while [ ! -s "$out" ] && [ "$tries" -lt 2 ]; do
      tries=$((tries+1))
      ZAI_API_KEY="$KEY" timeout 300 bun run src/cli.ts review --phase post --input "$P/artifact" -C "$2" 2>/dev/null > "$out" || true
    done
    echo "  $1_$i: $(grep -o '\"line\"' "$out" | wc -l) findings"
  done
}
rm -f "$P"/runs/*.json
OFF=$(mk_arm x 0 0); ON=$(mk_arm x 1 0); B=$(mk_arm x 0 1); AB=$(mk_arm x 1 1)
echo "baseline:"; run_arm off "$OFF"
echo "Tier-A:";   run_arm on  "$ON"
echo "Tier-B:";   run_arm tierb "$B"
echo "A+B:";      run_arm ab "$AB"
rm -rf "$OFF" "$ON" "$B" "$AB"
echo "DONE."
