# Contributing to AllStak Fastify SDK

Thanks for helping improve this SDK. Keep pull requests focused, reproducible, and easy to review.

## Development Setup


default branch on GitHub is the source of truth for pull requests. Fork the repository, create a topic branch from the default branch shown by GitHub, and open your PR back to that same default branch.


environment setup:

```bash
npm install
```

## Verification

Run the strongest relevant checks before opening a PR:

```bash
npm run build\nnpm test
```

For documentation-only changes, run the formatting or build checks that apply to the touched files.

## Pull Request Guidelines

- Explain the bug or workflow the PR fixes.
- Include a minimal reproduction for bug fixes when possible.
- Add or update tests when behavior changes.
- Update README or docs when public API, config, install steps, or behavior changes.
- Keep secrets, API keys, tokens, cookies, private URLs, and customer data out of issues, logs, tests, and commits.
- Keep public copy focused on AllStak behavior. Do not add external vendor names, migration positioning, or internal implementation notes.

## Security

Do not open public issues for vulnerabilities. Email security@allstak.sa or use GitHub Security Advisories for this repository.

## Code of Conduct

Be respectful, constructive, and collaborative. Contributors are expected to follow the Contributor Covenant: https://www.contributor-covenant.org/version/2/1/code_of_conduct/

## License

By contributing, you agree that your contributions will be licensed under this repository's license.
