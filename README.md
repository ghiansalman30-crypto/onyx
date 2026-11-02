# ONYX

A coin you mine from the terminal with SHA-256 proof-of-work.

    start.bat                 # or: npm install && node server.js   ->  http://127.0.0.1:4000

- `public/index.html` the website (3D core, live network stats, leaderboard, wallet sign-in)
- `server.js` the mining engine: wallet sign-in -> API key, challenges, share checks,
  per-miner difficulty (~1 share / 20 s), 60 s rounds, emission split by work, halving every 30 days
- `cli/` the `onyx` command (`onyx login <KEY>`, `onyx mine`, `onyx status`);
  after changing it run `cd cli && npm pack --pack-destination ../public` and rename to `onyx-cli.tgz`
- `data/onyx.db` balances and rounds (created on first run, not in git)

Economy: MAX_SUPPLY 50,000,000; emission per round = MAX_SUPPLY / (2 x rounds per 30 days) = 578.7.

Balances are an off-chain ledger. Paying them out as a real token is not built yet.
