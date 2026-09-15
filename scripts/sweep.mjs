/**
 * Fires the scheduled jobs the way cron would.
 *
 * Four endpoints run on a timer in production — checking bounces, sending
 * statements, chasing overdue invoices and warning a carrier about their own
 * cash. Each is authenticated by its own shared token and each is off entirely
 * until that token is set, which makes them awkward to try by hand: the right
 * `curl` is four lines long and one of them is a secret you should not be
 * pasting into a shell history.
 *
 *   npm run sweep              # everything that is switched on
 *   npm run sweep -- dunning   # just one
 *
 * It reads the same .env.local the application does, so a job it reports as
 * off is genuinely off rather than mistyped here. On a host without cron —
 * Windows, mostly — this is also the thing a scheduled task should call.
 */
import { readFileSync } from 'node:fs';

const JOBS = {
  bounces: {
    path: '/api/bounces/check',
    token: 'BOUNCE_CHECK_TOKEN',
    what: 'reads the bounce mailbox',
    /*
     * A second prerequisite, checked here rather than by calling and reading
     * the error back. Reading bounces needs a mailbox to read, and without
     * one the endpoint answers 502 — which is correct, and which a nightly
     * cron line would otherwise report as a failure every single night over a
     * feature nobody switched on. A job that cries wolf is a job whose output
     * stops being read.
     */
    also: 'IMAP_HOST',
  },
  statements: {
    path: '/api/statements/run',
    token: 'STATEMENT_RUN_TOKEN',
    what: 'sends statements of account',
  },
  dunning: {
    path: '/api/dunning/run',
    token: 'DUNNING_RUN_TOKEN',
    what: 'chases overdue invoices',
  },
  cash: {
    path: '/api/cash/alerts',
    token: 'CASH_ALERT_TOKEN',
    what: 'warns you about your own cash',
  },
};

/*
 * Read .env.local directly rather than relying on the runner.
 *
 * `node --env-file` would do it, but this script is also meant to be pasted
 * into a scheduled task where the working directory and the flags are easy to
 * get wrong. Reading the file we were pointed at fails loudly instead.
 */
function loadEnv(file = '.env.local') {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (!match) continue;

      const [, key, raw] = match;
      if (process.env[key] === undefined) {
        process.env[key] = raw.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // An instance configured entirely through real environment variables is
    // a perfectly ordinary deployment, so a missing file is not an error.
  }
}

loadEnv();

const base = (process.env.SWEEP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000')
  .trim()
  .replace(/\/+$/, '');

const asked = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const wanted = asked.length > 0 ? asked : Object.keys(JOBS);

const unknown = wanted.filter((name) => !(name in JOBS));
if (unknown.length > 0) {
  console.error(`Unknown job: ${unknown.join(', ')}`);
  console.error(`Try one of: ${Object.keys(JOBS).join(', ')}`);
  process.exit(2);
}

console.log(`Sweeping ${base}\n`);

let failures = 0;

for (const name of wanted) {
  const job = JOBS[name];
  const token = process.env[job.token];

  if (!token) {
    console.log(`  ${name.padEnd(11)} off — ${job.token} is not set`);
    continue;
  }

  if (job.also && !process.env[job.also]) {
    console.log(`  ${name.padEnd(11)} off — ${job.also} is not set`);
    continue;
  }

  try {
    const response = await fetch(`${base}${job.path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    const body = await response.text();
    let summary = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body);
      /*
       * Each endpoint reports its own shape, so the interesting fields differ.
       * Printing whichever are present beats inventing a common envelope that
       * every route would then have to be kept in step with.
       */
      summary = Object.entries(parsed)
        .filter(([key]) => key !== 'results')
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(' ');

      /*
       * Why nothing happened, when nothing happened.
       *
       * `sent=0` on its own reads as broken, and most of the time it is the
       * opposite: the sweep already ran today, or the projection has not
       * changed since the last warning, or every overdue invoice is one
       * somebody deliberately paused. Each route says so per organisation and
       * the top-level counters do not carry it, so without this the tool
       * sends you looking for a fault that is not there.
       */
      const reasons = Array.isArray(parsed.results)
        ? [...new Set(parsed.results.map((row) => row.reason ?? row.silent).filter(Boolean))]
        : [];

      if (reasons.length > 0) summary += `  — ${reasons.join('; ')}`;
    } catch {
      // Not JSON — a 401 or an HTML error page. Show it raw.
    }

    const ok = response.ok;
    if (!ok) failures += 1;
    console.log(`  ${name.padEnd(11)} ${ok ? 'ok ' : 'FAIL'} ${response.status}  ${summary}`);
  } catch (error) {
    failures += 1;
    console.log(`  ${name.padEnd(11)} FAIL  ${error instanceof Error ? error.message : error}`);
    if (String(error).includes('ECONNREFUSED')) {
      console.log('              (is the application running?)');
    }
  }
}

console.log();

/*
 * `exitCode` rather than `process.exit()`. Forcing the exit while the fetch
 * agent's sockets are still closing trips a libuv assertion on Windows, and a
 * scheduled task that prints a crash after doing its job correctly is one
 * somebody will waste an evening on.
 */
process.exitCode = failures > 0 ? 1 : 0;
