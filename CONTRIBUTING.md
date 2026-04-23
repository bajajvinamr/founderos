# Contributing to FounderOS

Thanks for your interest in FounderOS! This guide will help you get started contributing.

## Dev Setup

Clone the repo and install dependencies:

```bash
git clone https://github.com/founderos/founderos.git
cd founderos
pnpm install
```

Start the development server:

```bash
pnpm dev
```

Run the full test suite:

```bash
pnpm test:run
```

Run typecheck:

```bash
pnpm -r typecheck
```

## Branch Naming

Use descriptive, kebab-case branch names with a type prefix:

- `feat/agent-scheduling` — new feature
- `fix/json-parsing-error` — bug fix
- `chore/update-dependencies` — maintenance, refactoring, tooling
- `docs/contributing-guide` — documentation

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add agent scheduling API endpoint
fix: handle JSON parsing errors in response handler
docs: update API reference for v2.0
chore: upgrade @anthropic-ai/sdk to 0.30.0
```

**Commit messages should be clear and concise.** Reference issue numbers when applicable:

```
feat: implement webhook retry logic

Adds exponential backoff for failed webhook deliveries.
Resolves #742.
```

## Creating a Pull Request

1. Push your branch to GitHub
2. Open a PR against `dev` (for features/fixes) or `main` (for releases only)
3. Fill out the **PR template** completely — it's at `.github/PULL_REQUEST_TEMPLATE.md`
4. Include:
   - **Thinking Path**: Trace your reasoning from project context to this change (5–8 steps, see examples below)
   - **What Changed**: Concrete list of modifications
   - **How to Test**: Commands or manual steps to verify
   - **Risk Level**: Low/Medium/High + blast radius
   - **AI Model Used**: Specify if AI assisted (provider, model, version, capabilities)

## Thinking Path Examples

### Example 1: Adapter Configuration

> - FounderOS orchestrates ai-agents for zero-human companies
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or founderos managed
> - That way we can get optimal performance from any adapter/provider in FounderOS

### Example 2: Avatar Upload Bug

> - FounderOS orchestrates ai-agents for zero-human companies
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

## PR Checklist

Before requesting review, confirm:

- [ ] Tests pass: `pnpm test:run`
- [ ] Typecheck passes: `pnpm -r typecheck`
- [ ] No console errors
- [ ] Documentation updated (in code comments and `/docs`)
- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] PR size under 2000 lines (warn at 800+)
- [ ] Model version and context window documented (if AI-assisted)
- [ ] All required CI checks pass
- [ ] Greptile score is 5/5 with all comments addressed

## Required CI Checks

All PRs must pass:

1. **pr-lint** — PR title follows Conventional Commits, PR size ≤ 2000 LOC
2. **typecheck** — TypeScript strict mode
3. **test** — Unit + integration tests
4. **codeql** — Security scanning
5. **gitleaks** — Secret detection
6. **docker** — Docker image builds successfully (if applicable)

## Code Style

- **Formatter**: Prettier (auto-format on save recommended)
- **Linter**: ESLint (run `pnpm lint` to check)
- **Types**: TypeScript strict mode — all `any` must be justified
- **Immutability**: Prefer creating new objects over mutations
- **Error Handling**: Never silently swallow errors; log or rethrow
- **Testing**: Write tests for non-trivial logic. Target 80%+ coverage.

## Database Migrations

If you modify the schema in `/packages/db/prisma/schema.prisma`:

1. Create a migration:
   ```bash
   pnpm -w prisma migrate dev --name <descriptive_name>
   ```

2. Review the migration SQL in `/packages/db/prisma/migrations/`

3. Commit the migration file alongside your code changes

4. Document any manual steps in the migration comment

## Testing

Write tests for new features and bug fixes:

```bash
# Run all tests
pnpm test:run

# Run tests for a specific package
cd packages/db && pnpm test:run

# Run tests in watch mode (dev)
pnpm test
```

Test files live next to source code: `src/foo.test.ts` alongside `src/foo.ts`.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Greptile score is 5/5 with all comments addressed
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** talk about it in Discord → #dev channel  
  → Describe what you're trying to solve  
  → Share rough ideas / approach
- Once there's rough agreement, build it
- In your PR include:
  - Before / After screenshots (or short video if UI/behavior change)
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - Greptile score 5/5 with all comments addressed
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Questions?

- Check the [docs](https://docs.founderos.ai)
- Open a [discussion](https://github.com/founderos/founderos/discussions)
- File an [issue](https://github.com/founderos/founderos/issues) with questions tag
- Ask in #dev on Discord — we're happy to help

---

**Thank you for contributing!** 🚀
