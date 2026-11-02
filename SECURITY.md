# Security Policy

## Scope

Rekzora is a local, offline-first desktop application. There is:
- **no server** — the app makes no network connections of its own,
- **no account system**, no analytics, no telemetry,
- **no data** — recordings and settings never leave your machine.

The attack surface is therefore limited to the local app itself
(capture pipeline, file storage, IPC bridge, installer).

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅ yes    |

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

1. Email: **tahirshaikh744@gmail.com**
2. Subject line: `[SECURITY] Rekzora — <short summary>`
3. Include: affected version (see Rekzora → Settings → version), steps to reproduce, and any proof-of-concept.

You will get an acknowledgement within **15 business days**, and we aim to release a
fix in the next patch version. You are welcome to request credit in the advisory.

## Bounties

There is no paid bug bounty — Rekzora is a free, open-source hobby project.
Security researchers who responsibly disclose issues will be credited in the
release notes with thanks.
