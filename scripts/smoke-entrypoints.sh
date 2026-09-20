#!/usr/bin/env bash
# Loads every compiled service entrypoint in its own Node process to prove the
# emitted code resolves and evaluates. Each service is looked up at whichever
# location it currently occupies, so a half-migrated tree still checks all seven.
set -euo pipefail

SERVICES=(scheduler worker crawler manager webhook discord-bot metrics)
FAILED=0

for s in "${SERVICES[@]}"; do
  if [ -f "dist/services/$s/index.js" ]; then
    target="./dist/services/$s/index.js"
  elif [ -f "dist/commands/$s.js" ]; then
    target="./dist/commands/$s.js"
  else
    printf '%-14s MISSING (no compiled entrypoint)\n' "$s"
    FAILED=1
    continue
  fi

  # An explicit exit is required: some entrypoints build a cache at module
  # scope, which holds a Redis socket and an interval timer open, so the
  # process would never end on its own. The deadline turns a module that
  # genuinely wedges into a failure instead of a hang.
  if node --input-type=module -e "
      const t = setTimeout(() => {
        console.error('TIMEOUT: module did not finish loading');
        process.exit(2);
      }, 20000);
      await import('$target');
      clearTimeout(t);
      process.exit(0);
    "; then
    printf '%-14s ok   %s\n' "$s" "$target"
  else
    printf '%-14s FAILED %s\n' "$s" "$target"
    FAILED=1
  fi
done

exit "$FAILED"
