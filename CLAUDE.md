# ONYX: project notes for Claude

ONYX is a coin you mine from a terminal with SHA-256 proof-of-work. It is **not an AI agent**. The owner talks in casual Indonesian; answer the same way.

## What it is

- **Concept and engine** are modeled on [orex.run](https://orex.run). The code is our own, not copied from OREX.
- **Flow:** connect a wallet on the website, sign once, get an API key, install the CLI, run `onyx login <KEY>`, then `onyx mine`.
- **Economy:** 60 s rounds, a fixed emission per round (578.7 ONYX), split by work. Emission halves every 30 days and the max supply is 50,000,000.
- **Difficulty:** tuned per miner, about one share per 20 s, and a share is worth 2^bits of work.
- **Anti-bot:** every miner re-confirms with a wallet signature every 30 min, and at most 3 wallets may mine from one IP.
- **Ledger:** off-chain SQLite (`data/onyx.db`, git-ignored), with hourly backups in `data/backups`. Nothing is on-chain yet.
- **Difference from OREX:** OREX splits a round equally between its miners; ONYX splits by work. The owner was offered a switch and has not decided.

## Files

- `server.js`: website, API and mining engine, on Node 22.5+ (uses `node:sqlite`). Runs on http://127.0.0.1:4000.
- `cli/`: the `onyx` CLI (`login`, `mine`, `status`). `public/onyx-cli.tgz` is the packed copy the site serves; rebuild it with `npm pack` in `cli/` after any CLI change.
- `public/index.html`: the whole site, one file. It is the ORRERY template (three.js r128, self-hosted in `public/vendor`) rebranded, CONFIG-driven, in 8 languages: EN and ID inline, the others in `public/lang/*.json`.

## Visual decisions the owner made (keep them)

- **Moon palette, dark theme:** Black #000000, Cool Gray 1 #E2E2E2, Full Moon #919095, Charcoal Gray #6A6A6A, Moon Rock #948D83, Moon Mist #80817C.
- **Background:** black sky with a moonlit haze and two slow gray smoke blobs.
- **Stars must take turns:** at any moment some are bright and some are dim. Not all dim.
- **Shooting stars:** three lanes, sometimes one at a time and sometimes together. Each flies all the way off the screen edge and never fades out mid-screen.
- **Shaders use a sin-free hash.** Do not go back to `fract(sin(...))`, because it causes diagonal banding.
- **Round numbers** are shown counted from genesis (`firstRound` in `/api/stats`).
- **TUNE** lives in the footer, and the 3D core is dimmed on phones.

## Status (2026-11-03)

- **Works locally:** the end-to-end test passed (wallet login, mining, anti-bot check, payout, CLI). Test data was deleted.
- **Not deployed.** The suggested domain is `mineonyx.com`, or `onyxmine.xyz`. `onyx.com` and `onxy.com` are premium resale only.
- **Missing:** the X and Telegram links and the token CA (`CONFIG.ca` and `CONFIG.footer` in `index.html`).

## Run

```
npm install
npm start          # or start.bat on the original PC
```
