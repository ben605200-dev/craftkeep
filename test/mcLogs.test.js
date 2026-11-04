/**
 * Unit tests for the Minecraft console parser.
 *
 * Run with:  npm test
 *
 * These cover the cases that are easy to regress and expensive to notice:
 * CRLF handling (a Windows host writes `\r\n`, and treating the trailing `\r`
 * as an in-line rewrite silently discards every line), ANSI stripping, and the
 * lifecycle events the status machine depends on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitLines, parseLine, stripAnsi, startProgressFor } from '../server/lib/mcLogs.js';

// ---------------------------------------------------------------------------
// Line splitting
// ---------------------------------------------------------------------------

test('splitLines keeps CRLF lines intact', () => {
  const { lines, carry } = splitLines('', 'one\r\ntwo\r\nthree\r\n');
  assert.deepEqual(
    lines.map((l) => l.text),
    ['one', 'two', 'three'],
    'trailing \\r must be treated as a line terminator, not a rewrite',
  );
  assert.equal(carry, '');
});

test('splitLines handles LF only', () => {
  const { lines } = splitLines('', 'a\nb\n');
  assert.deepEqual(lines.map((l) => l.text), ['a', 'b']);
});

test('splitLines carries an incomplete line across chunks', () => {
  const first = splitLines('', 'hello ');
  assert.deepEqual(first.lines, []);
  assert.equal(first.carry, 'hello ');

  const second = splitLines(first.carry, 'world\n');
  assert.deepEqual(second.lines.map((l) => l.text), ['hello world']);
  assert.equal(second.carry, '');
});

test('splitLines treats an in-line carriage return as a rewrite', () => {
  const { lines } = splitLines('', 'Preparing spawn area: 42%\rPreparing spawn area: 84%\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Preparing spawn area: 84%');
  assert.equal(lines[0].carriage, true);
});

test('splitLines does not mistake CRLF for a rewrite', () => {
  const { lines } = splitLines('', 'keep me\r\n');
  assert.equal(lines[0].text, 'keep me');
  assert.equal(lines[0].carriage, false);
});

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

test('stripAnsi removes colour and cursor sequences', () => {
  assert.equal(stripAnsi('\u001b[0;32mDone\u001b[m'), 'Done');
  assert.equal(stripAnsi('\u001b[1;31;40mERROR\u001b[0m rest'), 'ERROR rest');
  assert.equal(stripAnsi('\u001b]0;window title\u0007text'), 'text');
  assert.equal(stripAnsi('\u001b(Bplain'), 'plain');
});

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

test('parses the vanilla log shape', () => {
  const record = parseLine('[12:34:56] [Server thread/INFO]: Starting minecraft server version 1.21.8', 'stdout');
  assert.equal(record.time, '12:34:56');
  assert.equal(record.thread, 'Server thread');
  assert.equal(record.level, 'info');
  assert.equal(record.message, 'Starting minecraft server version 1.21.8');
  assert.equal(record.event.type, 'version');
  assert.equal(record.event.version, '1.21.8');
});

test('parses the Paper log shape', () => {
  const record = parseLine('[12:34:56 INFO]: Preparing level "world"', 'stdout');
  assert.equal(record.time, '12:34:56');
  assert.equal(record.level, 'info');
  assert.equal(record.message, 'Preparing level "world"');
});

test('detects the ready event and its boot time', () => {
  const record = parseLine('[12:34:56] [Server thread/INFO]: Done (5.113s)! For help, type "help"', 'stdout');
  assert.equal(record.kind, 'event');
  assert.equal(record.level, 'success');
  assert.deepEqual(record.event, { type: 'ready', seconds: 5.113 });
});

test('detects player join, leave and chat', () => {
  const join = parseLine('[12:00:00] [Server thread/INFO]: Steve joined the game', 'stdout');
  assert.equal(join.event.type, 'join');
  assert.equal(join.event.player, 'Steve');

  const leave = parseLine('[12:00:01] [Server thread/INFO]: Steve left the game', 'stdout');
  assert.equal(leave.event.type, 'leave');
  assert.equal(leave.event.player, 'Steve');

  const chat = parseLine('[12:00:02] [Server thread/INFO]: <Steve> hello there', 'stdout');
  assert.equal(chat.kind, 'chat');
  assert.equal(chat.event.player, 'Steve');
  assert.equal(chat.event.text, 'hello there');
});

test('detects the actionable failure modes', () => {
  assert.equal(parseLine('[12:00:00] [Server thread/ERROR]: You need to agree to the EULA', 'stdout').event.type, 'eula-required');
  assert.equal(
    parseLine('[12:00:00] [Server thread/ERROR]: FAILED TO BIND TO PORT!', 'stdout').event.type,
    'port-conflict',
  );
  assert.equal(
    parseLine('[12:00:00] [Server thread/ERROR]: java.lang.OutOfMemoryError: Java heap space', 'stdout').event.type,
    'out-of-memory',
  );
  assert.equal(
    parseLine(
      '[12:00:00] [main/ERROR]: java.lang.UnsupportedClassVersionError: compiled for the newer version',
      'stdout',
    ).event.type,
    'java-mismatch',
  );
});

test('marks java stack frames as stack records', () => {
  const record = parseLine('\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:871)', 'stderr');
  assert.equal(record.kind, 'stack');
  assert.equal(record.level, 'error');
});

test('stderr defaults to error but structured levels win', () => {
  assert.equal(parseLine('some raw stderr text', 'stderr').level, 'error');
  assert.equal(parseLine('[12:00:00] [Server thread/INFO]: fine', 'stderr').level, 'info');
  assert.equal(parseLine('[12:00:00] [Server thread/WARN]: careful', 'stdout').level, 'warn');
});

test('blank lines are flagged instead of parsed', () => {
  assert.equal(parseLine('   ', 'stdout').kind, 'blank');
  assert.equal(parseLine('', 'stdout').kind, 'blank');
});

// ---------------------------------------------------------------------------
// Boot progress
// ---------------------------------------------------------------------------

test('startProgressFor advances monotonically through boot milestones', () => {
  const start = startProgressFor('Starting minecraft server version 1.21.8');
  const props = startProgressFor('Loading properties');
  const level = startProgressFor('Preparing level "world"');
  const done = startProgressFor('Done (5.1s)! For help, type "help"');

  assert.ok(start < props, 'loading properties should be further along than the version banner');
  assert.ok(props < level, 'preparing the level should be further along than loading properties');
  assert.equal(done, 1);
});
