# Security policy

## Supported versions

Only the latest release of the npm package [`loopstra`](https://www.npmjs.com/package/loopstra) gets
security fixes. A fix ships as a new version; older versions are not patched. `loopstra upgrade`
moves an install to the latest one.

## Reporting a vulnerability

Please report it privately, through GitHub's private vulnerability reporting:
[open a report](https://github.com/jflavan/loopstra/security/advisories/new) (or, on the repository's
Security tab, "Report a vulnerability"). Do not open a public issue or pull request for it, and do not
post it in a discussion.

Say what you found, what someone could do with it, the Loopstra version (`loopstra --version`) and
your platform, and the steps that show it. A proof of concept helps but is not needed.

## What happens next

- You get an answer within 7 days saying whether it is taken as a vulnerability.
- While it is being fixed, the report stays private between you and the maintainer. You are told
  when the fix is released.
- The fix is released as a new version, with a GitHub security advisory that credits you, unless you
  would rather not be named.
- Please keep it to yourself until the fix is out, or for 90 days from your report, whichever comes
  first. If a fix needs longer, we will say why and agree a date with you.

## Scope

In scope: the code in this repository and the package built from it. That includes the loop and its
checkouts, the local console server, the Slack and Discord bots and the tokens they hold, the hook
`loopstra init` installs, and the release workflow.

Out of scope: vulnerabilities in Claude Code, Bun, git or the GitHub CLI themselves (report those to
their projects), and what an agent session does when the repository's own prompts or settings tell it
to.
