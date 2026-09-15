/**
 * A mail server that accepts everything and delivers nothing.
 *
 * OpenHaul sends five kinds of mail — documents, statements, dunning notices,
 * bounce probes and cash warnings — and none of them can be exercised without
 * an SMTP server. Signing up for a provider to find out whether a button works
 * is a poor trade, and pointing a half-configured instance at a real one is
 * worse: the first thing you learn is that you have emailed a customer.
 *
 * So this listens on 127.0.0.1, says yes to every command, and writes what it
 * was given to a directory. It is not a mail server in any sense that matters:
 * no authentication, no TLS, no queue, no delivery. It exists so that
 * `SMTP_HOST=127.0.0.1` and `SMTP_PORT=2525` make the application's own
 * sending path run end to end, which is the only part worth testing before a
 * provider is in the picture.
 *
 *   npm run mail:sink
 *
 * Never run this anywhere it can be reached from outside the machine. It is
 * an open relay that throws the post away.
 */
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? process.env.MAIL_SINK_PORT ?? 2525);
const OUT = path.join(process.cwd(), 'data', 'mail');

mkdirSync(OUT, { recursive: true });

/**
 * Undoes quoted-printable, through bytes rather than characters.
 *
 * The obvious one-liner — replacing each `=XX` with `String.fromCharCode` — is
 * wrong for anything outside ASCII, and every message this application sends
 * has an em-dash in it. `—` is three bytes in UTF-8, and that approach turns
 * it into three Latin-1 characters: the preview reads `â` and you go looking
 * for an encoding bug in the application that is not there. A test tool that
 * garbles its output is worse than no test tool.
 */
function decodeQuotedPrintable(text) {
  const bytes = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }

  return Buffer.from(bytes).toString('utf8');
}

/** Body text: drop the soft line breaks first, then decode the bytes. */
function decodeBody(body) {
  return decodeQuotedPrintable(body.replace(/=\r?\n/g, ''));
}

/**
 * Header values arrive folded across lines and MIME word-encoded.
 *
 * RFC 2047 treats whitespace *between* two adjacent encoded words as a
 * separator rather than as text, which is why a long subject comes out with a
 * double space in it if you simply join the pieces up.
 */
function header(raw, name) {
  const match = new RegExp(`^${name}:\\s*((?:.|\\r?\\n[ \\t])*)`, 'im').exec(raw);
  if (!match) return '';

  return match[1]
    .replace(/\r?\n[ \t]/g, '')
    .trim()
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?Q\?(.*?)\?=/gi, (_, text) =>
      decodeQuotedPrintable(text.replace(/_/g, ' ')),
    )
    .replace(/=\?UTF-8\?B\?(.*?)\?=/gi, (_, text) =>
      Buffer.from(text, 'base64').toString('utf8'),
    );
}

let count = 0;

const server = createServer((socket) => {
  let buffer = '';
  let body = '';
  let inData = false;
  let envelope = { from: '', to: [] };

  const say = (line) => socket.write(`${line}\r\n`);
  say('220 mail-sink.localhost ESMTP OpenHaul test sink');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    for (;;) {
      const at = buffer.indexOf('\r\n');
      if (at === -1) break;

      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);

      if (inData) {
        if (line !== '.') {
          // A leading dot is doubled by the sender; undo it.
          body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }

        inData = false;
        count += 1;

        const subject = header(body, 'Subject') || '(no subject)';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(OUT, `${stamp}-${String(count).padStart(3, '0')}.eml`);
        writeFileSync(file, body);

        const separator = body.indexOf('\n\n');
        const text = separator === -1 ? '' : decodeBody(body.slice(separator + 2));
        const attachment = /filename="?([^"\r\n;]+)/.exec(body)?.[1];

        console.log(`\n${'─'.repeat(72)}`);
        console.log(`  to       ${envelope.to.join(', ')}`);
        console.log(`  subject  ${subject}`);
        if (attachment) console.log(`  attached ${attachment}`);
        console.log(`  saved    ${path.relative(process.cwd(), file)}`);
        console.log('─'.repeat(72));
        console.log(
          text
            .split('\n')
            .slice(0, 24)
            .map((row) => `  ${row}`)
            .join('\n'),
        );

        body = '';
        envelope = { from: '', to: [] };
        say('250 2.0.0 Ok: queued as nothing');
        continue;
      }

      const command = line.toUpperCase();

      if (command.startsWith('EHLO') || command.startsWith('HELO')) {
        say('250-mail-sink.localhost');
        say('250 8BITMIME');
      } else if (command.startsWith('MAIL FROM')) {
        envelope.from = line.slice(line.indexOf(':') + 1).trim();
        say('250 2.1.0 Ok');
      } else if (command.startsWith('RCPT TO')) {
        envelope.to.push(
          line
            .slice(line.indexOf(':') + 1)
            .trim()
            .replace(/^<|>$/g, ''),
        );
        say('250 2.1.5 Ok');
      } else if (command === 'DATA') {
        inData = true;
        say('354 End data with <CR><LF>.<CR><LF>');
      } else if (command === 'RSET') {
        body = '';
        envelope = { from: '', to: [] };
        say('250 2.0.0 Ok');
      } else if (command === 'QUIT') {
        say('221 2.0.0 Bye');
        socket.end();
      } else {
        say('250 2.0.0 Ok');
      }
    }
  });

  socket.on('error', () => socket.destroy());
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another sink is probably still running.`);
    process.exit(1);
  }
  throw error;
});

// Loopback only, and said out loud. An open relay on 0.0.0.0 would be found.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mail sink listening on 127.0.0.1:${PORT} — loopback only, delivers nothing.`);
  console.log(`Messages are written to ${path.relative(process.cwd(), OUT)}/`);
  console.log(`Set SMTP_HOST="127.0.0.1" and SMTP_PORT="${PORT}" to use it.\n`);
});
