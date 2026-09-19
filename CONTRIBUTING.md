# Contributing to GMRec

**Anyone can contribute.** No invitation, no prior involvement, no gatekeeping. Open an issue,
send a pull request, or fix a typo — all of it is welcome.

That includes **AI agents and LLMs**. This project is written to be machine-readable: start with
**[AGENTS.md](AGENTS.md)**, which maps the architecture, states the invariants that are easy to
break, and lists approaches already tried and measured.

## Before you start

```bash
npm install
npm run typecheck
npm test
npm run build
```

For anything touching recording, media, or the DOM, also run the integration suite in a real
Chrome:

```bash
GMREC_CHROMIUM_PATH="/path/to/chrome" npm run test:browser
```

It uses a disposable profile, a synthetic Meet fixture and fake devices — never your real
profile, camera or microphone.

## Sending a change

1. Fork and branch.
2. Make the change. Read **[AGENTS.md](AGENTS.md)** first if you are touching `src/recorder.ts`
   or `src/content.ts`; a few things there look wrong and are deliberate.
3. Add or update a test. Pure logic goes in `tests/unit.test.mjs`; anything involving real media
   or Chrome APIs goes in `tests/browser-smoke.mjs`.
4. Run typecheck, unit tests, and the browser suite.
5. Open a pull request describing **what changed and why**, and say which checks you ran. If you
   could not run the browser suite, say so — that is fine, just be explicit.

## Style

- Comments explain *why*, not *what*. Record the trap you hit, not the syntax.
- Match the density of the file you are editing. This codebase is deliberately compact.
- No new runtime dependencies. The extension ships zero.
- No reformatting of code you are not otherwise changing.

## Reporting a bug

Include: Chrome version, OS, what you selected, what you expected, what happened, and anything in
the popup's warning area. For bad output files, the contents of `recording-info.json` from that
session folder is extremely useful — it records the codec, resolution, duration and status of
every file.

## Security

GMRec records people. If you find something that lets a page, another extension, or a non-Meet
tab start a recording, reach a recording it does not own, or write outside the Downloads folder,
please report it privately to the maintainer before opening a public issue.

## Scope

Some things are out of scope unless the maintainer asks: telemetry or any network call, accounts
and cloud sync, third-party transcription, broader host permissions, and anything that makes
recording less visible to the person doing it. Open an issue and make the case first.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
