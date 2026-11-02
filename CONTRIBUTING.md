# Contributing to Rekzora

Thank you for considering a contribution! Rekzora is a free, open-source
screen recorder by **NEURON TS LABS** — contributions big and small are welcome.

## Getting started

```powershell
git clone https://github.com/tahirshaikh744-design/rekzora.git
cd rekzora
npm install
npm start
```

(Windows 10/11 + Node.js 18+. See the README's *Install from source* section for the detailed step-by-step.)

## How to contribute

1. **Open an issue first** for anything that changes behavior or design — so we can agree on the approach before code is written.
2. Create a feature branch: `git checkout -b my-feature`
3. Make your change, then test:
   - `npm start` — manual smoke of the affected flow,
   - `scripts\smoke-run.bat` — headless record-3s-and-verify self-test,
   - `npm run dist` — only if packaging changed.
4. Commit with a clear, imperative message: `record: fix pause during countdown`
5. Open a Pull Request. Small, focused PRs are reviewed and merged fastest.

## Ground rules

- **Design:** keep the UI minimal, flat and translucent — the existing design tokens
  live in `src/renderer/styles.css` and should be reused, not re-invented per page.
- **Privacy:** no new telemetry, no network calls, no third parties. If a feature
  must access the network, it does so via the user's own apps (see the EULA text in
  `build/license.txt`).
- **Windows first, Windows only:** leverage Windows capabilities (loopback audio,
  per-user installs) instead of cross-platform abstractions.
- **No new dependencies** unless the feature genuinely needs one — the runtime is
  currently Electron-only, zero npm runtime deps.
- **Code style:** plain modern JavaScript (ES2022), 2-space indent, single quotes,
  and `/* section comments */` in main.js style for each block.

## Bug reports

Use the issue template gist: description, Rekzora version (Settings shows it),
Windows version, steps to reproduce, and `logs\rekzora.log` (start via
`Start-Rekzora.bat` to produce it). Redact any private info.

## License

By contributing you agree that your contributions will be licensed under the
[MIT license](LICENSE).
