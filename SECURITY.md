# Security Policy

## Supported Versions

This project is experimental. Security fixes are provided for the latest published version only.

## Reporting a Vulnerability

Please report security issues privately by emailing the maintainer or using GitHub's private vulnerability reporting if it is enabled for the repository.

Do not open a public issue for vulnerabilities that could expose user data, credentials, or local system access.

## Scope

This plugin does not intentionally read credentials, write files, or execute shell commands. It observes OpenCode session events, injects goal context into prompts, and sends continuation prompts through OpenCode's SDK client.

Relevant security-sensitive areas include:

- prompt-injection resistance for goal text
- unexpected auto-continuation behavior
- incorrect command or hook handling across OpenCode versions
- leakage of goal text through logs or status output

