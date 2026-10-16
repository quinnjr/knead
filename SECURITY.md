# Security policy

## Reporting a vulnerability

Do not put vulnerability details in a public issue, pull request or
discussion.

**Once this repository is public**, report vulnerabilities privately through
GitHub private vulnerability reporting: open the repository's **Security** tab
and choose **Report a vulnerability**
(<https://github.com/quinnjr/high-performance-modular-web-server/security/advisories/new>).

**At any time**, you can email the maintainer at
<quinn.josephr@protonmail.com> (use the subject "hpmws security report"). While
the repository is private this is the only reporting channel, because GitHub
private vulnerability reporting is not available and outside reporters cannot
open issues.

In the private report, include the affected package(s) and version(s), a
description of the impact, and steps or a proof of concept to reproduce it.

## Supported versions

hpmws is released as a fixed set of `@hpmws/*` packages that all share one
version.

| Version                      | Supported          |
| ---------------------------- | ------------------ |
| Latest release               | Yes                |
| Older releases               | No: please upgrade |

While hpmws is below 1.0.0, fixes ship only in a new release of the latest
minor line.

## What to expect

- An acknowledgement within 3 business days.
- An initial assessment (confirmed or not, and severity) within 10 business days.
- For confirmed issues, a fix and a published advisory, coordinated with you,
  normally within 90 days of the report. Critical issues are prioritised.
- Credit in the advisory if you would like it.

## Scope

In scope: the published `@hpmws/*` packages and this repository's release
pipeline. The example applications under `examples/` are demos; issues in them
are welcome but are not treated as vulnerabilities in hpmws itself unless they
show a flaw in a published package.
