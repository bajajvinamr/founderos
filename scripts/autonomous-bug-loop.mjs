#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const getArg = (name, fallback) => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const intervalMinutes = Number(getArg('--interval-minutes', process.env.AUTONOMOUS_LOOP_INTERVAL_MINUTES ?? '60'));
const maxIterations = Number(getArg('--max-iterations', process.env.AUTONOMOUS_LOOP_MAX_ITERATIONS ?? '1'));
const mode = getArg('--mode', process.env.AUTONOMOUS_LOOP_MODE ?? 'standard');
const reportDir = getArg('--report-dir', process.env.AUTONOMOUS_LOOP_REPORT_DIR ?? '.autonomous-loop/reports');
const failOnFindings = args.has('--fail-on-findings') || process.env.AUTONOMOUS_LOOP_FAIL_ON_FINDINGS === '1';
const reportOnly = args.has('--report-only') || process.env.AUTONOMOUS_LOOP_REPORT_ONLY === '1';
const runHeavy = args.has('--heavy') || mode === 'heavy' || process.env.AUTONOMOUS_LOOP_HEAVY === '1';

const ignoredDirs = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'test-results', 'playwright-report',
  '.autonomous-loop', '.claude', '.planning', '.vercel', '.turbo', '.cache', 'tmp', 'logs', '.next', '.vite',
]);
const textExts = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.toml', '.sh', '.css', '.html', '.sql', '.env.example',
]);
const secretNamePattern = /(^|\/)(\.env($|\.)|.*\.(pem|key|p12|pfx)$)/i;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runCommand(name, command, commandArgs, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
    timeout: options.timeoutMs ?? 1000 * 60 * 10,
    shell: false,
  });
  return {
    name,
    command: [command, ...commandArgs].join(' '),
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    stdout: truncate(result.stdout ?? ''),
    stderr: truncate(result.stderr ?? ''),
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function truncate(value, max = 12000) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... <truncated ${value.length - max} chars>`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (secretNamePattern.test(rel)) continue;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function isTextCandidate(path) {
  const rel = relative(root, path);
  if (secretNamePattern.test(rel)) return false;
  const size = statSync(path).size;
  if (size > 1024 * 512) return false;
  return [...textExts].some((ext) => rel.endsWith(ext));
}

const bugPatterns = [
  { severity: 'P1', id: 'silent-catch', regex: /catch\s*\([^)]*\)\s*\{\s*\}/g, why: 'empty catch block can hide runtime/security failures' },
  { severity: 'P1', id: 'destructive-sql', regex: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(?:;|$))/gi, why: 'destructive SQL must be explicitly reviewed' },
  { severity: 'P1', id: 'auth-bypass-marker', regex: /\b(TODO|FIXME|HACK)\b.*\b(auth|permission|tenant|company|billing|secret|token)\b/gi, why: 'security/tenant/billing TODO in sensitive path' },
  { severity: 'P2', id: 'no-floating-await', regex: /\b(setTimeout|setInterval)\s*\(\s*async\s*\(/g, why: 'async timer callback often drops rejected promises' },
  { severity: 'P2', id: 'process-env-direct', regex: /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*/g, why: 'secret reads should go through validated config/vault paths' },
  { severity: 'P2', id: 'todo-fixme', regex: /\b(TODO|FIXME|HACK)\b/g, why: 'known unfinished work' },
  { severity: 'P3', id: 'console-error-swallow', regex: /catch\s*\([^)]*\)\s*\{[^}]*console\.(log|warn)\([^}]*\}/g, why: 'catch may log but continue without propagating failure' },
];

function scanPatterns() {
  const findings = [];
  for (const file of walk(root).filter(isTextCandidate)) {
    const rel = relative(root, file);
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const pattern of bugPatterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(text)) && findings.length < 500) {
        const line = text.slice(0, match.index).split(/\r?\n/).length;
        findings.push({
          severity: pattern.severity,
          id: pattern.id,
          file: rel,
          line,
          quote: lines[line - 1]?.trim().slice(0, 240) ?? '',
          why: pattern.why,
        });
        if (match.index === pattern.regex.lastIndex) pattern.regex.lastIndex += 1;
      }
    }
  }
  return findings;
}

function renderMarkdown(run) {
  const failedCommands = run.commands.filter((cmd) => cmd.exitCode !== 0 || cmd.signal || cmd.error);
  const grouped = run.findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    `# FounderOS Autonomous Bug Loop Report`,
    ``,
    `- generated: ${run.generatedAt}`,
    `- mode: ${run.mode}`,
    `- iteration: ${run.iteration}`,
    `- failed commands: ${failedCommands.length}`,
    `- pattern findings: ${run.findings.length}`,
    `- finding summary: ${Object.entries(grouped).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    ``,
    `## Command results`,
    ``,
  ];
  for (const cmd of run.commands) {
    lines.push(`### ${cmd.name}`);
    lines.push(`- command: \`${cmd.command}\``);
    lines.push(`- exit: ${cmd.exitCode ?? 'null'}${cmd.signal ? ` (${cmd.signal})` : ''}`);
    lines.push(`- duration: ${cmd.durationMs}ms`);
    if (cmd.error) lines.push(`- error: ${cmd.error}`);
    if (cmd.stdout.trim()) lines.push(`\n<details><summary>stdout</summary>\n\n\`\`\`\n${cmd.stdout.trim()}\n\`\`\`\n</details>`);
    if (cmd.stderr.trim()) lines.push(`\n<details><summary>stderr</summary>\n\n\`\`\`\n${cmd.stderr.trim()}\n\`\`\`\n</details>`);
    lines.push('');
  }
  lines.push(`## Pattern findings`);
  lines.push('');
  if (!run.findings.length) {
    lines.push('No pattern findings.');
  } else {
    for (const finding of run.findings) {
      lines.push(`- [${finding.severity}] ${finding.id} — ${finding.file}:${finding.line}`);
      lines.push(`  - quote: \`${finding.quote.replaceAll('`', '\\`')}\``);
      lines.push(`  - why: ${finding.why}`);
    }
  }
  lines.push('');
  lines.push('## Safety notes');
  lines.push('');
  lines.push('- This loop is read-only except for writing reports under `.autonomous-loop/reports/`.');
  lines.push('- It does not push, deploy, mutate databases, or edit secrets.');
  lines.push('- Treat pattern findings as leads; verify before filing/fixing.');
  return `${lines.join('\n')}\n`;
}

function oneIteration(iteration) {
  const commands = [
    runCommand('git status', 'git', ['status', '--short'], { timeoutMs: 30_000 }),
    runCommand('forbidden token check', 'pnpm', ['check:tokens'], { timeoutMs: 120_000 }),
    runCommand('typecheck', 'pnpm', ['typecheck'], { timeoutMs: 8 * 60_000 }),
    runCommand('lint', 'pnpm', ['lint'], { timeoutMs: 8 * 60_000 }),
  ];
  if (runHeavy) {
    commands.push(runCommand('test run', 'pnpm', ['-w', 'run', 'test', '--', '--run'], { timeoutMs: 20 * 60_000 }));
    commands.push(runCommand('build', 'pnpm', ['build'], { timeoutMs: 20 * 60_000 }));
  }

  const run = {
    generatedAt: new Date().toISOString(),
    mode,
    iteration,
    commands,
    findings: scanPatterns(),
  };
  mkdirSync(reportDir, { recursive: true });
  const base = join(reportDir, `${timestamp()}-iteration-${iteration}`);
  writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
  writeFileSync(`${base}.md`, renderMarkdown(run));
  writeFileSync(join(reportDir, 'latest.md'), renderMarkdown(run));
  writeFileSync(join(reportDir, 'latest.json'), JSON.stringify(run, null, 2));
  console.log(`wrote ${base}.md`);
  return run;
}

if (!existsSync('package.json')) {
  console.error('Run from the FounderOS repository root.');
  process.exit(2);
}

let shouldFail = false;
for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
  const run = oneIteration(iteration);
  const commandFailed = run.commands.some((cmd) => cmd.exitCode !== 0 || cmd.signal || cmd.error);
  const criticalFinding = run.findings.some((finding) => finding.severity === 'P1');
  shouldFail ||= commandFailed || (failOnFindings && criticalFinding);
  if (iteration < maxIterations) {
    const sleepMs = Math.max(1, intervalMinutes) * 60_000;
    console.log(`sleeping ${intervalMinutes} minute(s) before next iteration`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  }
}

process.exit(shouldFail && !reportOnly ? 1 : 0);
