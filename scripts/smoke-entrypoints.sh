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

# Model registration walks the emitted dist/models/ directory with a
# non-recursive readdir, so a model that stops being emitted there registers
# nothing and raises no error. The webhook service looks models up by
# collection name from a runtime string, which means the omission first
# surfaces when an event for that collection arrives — in production, long
# after every build, lint and test run has passed. Comparing the registry
# against the source directory turns that silent gap into a failure here.
# Both counts are derived inside the one Node process, so there is no stored
# baseline to drift and the check stays correct as models are added.
if ! node --input-type=module <<'NODE'
  const t = setTimeout(() => {
    console.error('TIMEOUT: models did not finish registering');
    process.exit(2);
  }, 30000);
  const { readdirSync } = await import('node:fs');
  const expected = readdirSync('src/models')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).length;
  const { importAllModels } = await import('./dist/modules/db.js');
  await importAllModels();
  const { mongoose } = await import('@typegoose/typegoose');
  const names = Object.keys(mongoose.models).sort();
  console.log(names.length + ' of ' + expected + ' registered: ' + names.join(', '));
  if (names.length !== expected) {
    console.error('model registration mismatch');
    process.exit(1);
  }
  clearTimeout(t);
  process.exit(0);
NODE
then
  printf '%-14s FAILED (model registration)\n' 'models'
  FAILED=1
fi

exit "$FAILED"
