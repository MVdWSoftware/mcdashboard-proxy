# Security policy

This project exists to reduce attack surface, so reports are welcome and taken seriously.

## Reporting a vulnerability

Do **not** open a public issue. Email **security@mvdw-software.com** with a description, the
version, and steps to reproduce. You get an acknowledgement within 3 working days. Fixes are
released as a patch version with a note in the [changelog](CHANGELOG.md); reporters are credited
unless they prefer otherwise.

## Supported versions

The latest minor release receives security fixes.

## Scope

In scope: bypasses of the route allowlist, rate limits, body/URL limits or token check; cache
poisoning or cross-user cache leaks (a `private`/per-player response served to anyone else);
`X-Forwarded-For` spoofing; request smuggling; denial of service by a single client that the
documented limits should have stopped.

Out of scope: volumetric network floods (use your host's or a CDN's network protection, see
[docs/security.md](docs/security.md)), vulnerabilities in the MCDashboard plugin itself (report those
in its repository), and misconfiguration such as publishing the admin port.
