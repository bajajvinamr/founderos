# Plugin Authoring Smoke Example

A FounderOS plugin

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
```

## Install Into FounderOS

```bash
pnpm founderos plugin install ./
```

## Build Options

- `pnpm build` uses esbuild presets from `@founderos/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.
