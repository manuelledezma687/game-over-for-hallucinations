Baselines are committed on purpose. After a green run you accept, refresh them:

    npm run eval && tsx scripts/gate.ts reports/current.json baselines/golden.json --update-baseline
    npm run eval:attacks && tsx scripts/gate.ts reports/attacks.json baselines/attacks.json --update-baseline

Until the first baseline exists, the gate only blocks on failing checks (no regression diff).
