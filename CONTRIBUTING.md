# Contributing

Commands wrap `@skyporch/daykeeper`; they do not make independent HTTP calls.
Add a typed SDK method first, then expose it as a command.

Keep output machine-readable JSON on stdout and diagnostics on stderr. Never
print or log API keys, tokens, request bodies, or provider response bodies.

Examples, fixtures, and documentation must stay synthetic: no real tenant
names, customer data, hostnames, or downstream product names.

Run the repository's checks before requesting review.
