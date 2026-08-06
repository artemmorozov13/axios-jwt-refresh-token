# Contributing

Thanks for taking the time to improve this package.

## Local Setup

```bash
npm ci
npm test -- --runInBand
npm run build
```

## Pull Requests

- Keep changes focused and covered by tests.
- Run `npm run lint`, `npm test -- --runInBand`, and `npm run build` before opening a PR.
- Update the README when public behavior or options change.

## Releases

The package publishes compiled files from `dist`. Always run `npm run build` before publishing.
