#!/bin/sh
# Deterministic interactive shell for e2e reference screenshots.
#
# `SHELL` points here under e2e (wdio.conf.ts `beforeSession`), so every Shells
# tab renders a fixed `$ ` prompt. The runner's own rc files would otherwise put
# `runner@runnervmXXXX:~/work/...` into every terminal capture, and that
# hostname changes on every CI run. Arguments pass straight through, so
# `$SHELL -c cmd` and `$SHELL -l` behave as they would with bash itself.
PS1='$ '
export PS1
exec /bin/bash --noprofile --norc "$@"
