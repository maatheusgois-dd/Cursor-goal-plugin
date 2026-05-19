# Security Policy

## Supported Versions

This project is experimental. Security fixes are provided for the latest published version only.

## Reporting a Vulnerability

Private vulnerability reporting is not currently enabled for this repository. If it is enabled later, please use it for sensitive reports.

Until then, do not open a public issue with exploit details, credentials, local paths,
or reproduction steps that could expose user data, credentials, or local system access.
Open a minimal public issue asking for a private contact path, or contact the maintainer
through their GitHub profile.

## Scope

This plugin does not intentionally read credentials, write files, or execute shell commands. It observes OpenCode session events, injects goal context into prompts, and sends continuation prompts through OpenCode's SDK client.

Relevant security-sensitive areas include:

- prompt-injection resistance for goal text
- unexpected auto-continuation behavior
- incorrect command or hook handling across OpenCode versions
- leakage of goal text through logs or status output

The goal text is wrapped in `<goal_objective>` tags and the closing tag is escaped before insertion. Other structural tags used in continuation prompts (`<goal_continuation>`, `<progress_budget>`, etc.) are not escaped. Crafted goal text containing those literal strings would close the tag early in the plaintext prompt; the model treats it as text rather than structure, so the practical risk for a local single-user tool is negligible. Do not paste untrusted third-party text into a goal; treat goal text as if you typed it directly into the assistant.
