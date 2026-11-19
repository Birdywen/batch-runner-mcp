// omega_edit diff: "-" shows the whole original line(s), "+" the whole new line(s).
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OMEGA_JOB_DIR = mkdtempSync(path.join(tmpdir(), 'omega-jobs-test-'));
process.env.OMEGA_ARTIFACT_DIR = mkdtempSync(path.join(tmpdir(), 'omega-art-test-'));
const mod = await import('./tools-ext.mjs');
const omegaEdit = mod.omegaEdit;
assert.equal(typeof omegaEdit, 'function', 'omegaEdit export expected');
const dir = mkdtempSync(path.join(tmpdir(), 'edit-diff-'));
let n = 0;
const ok = (m) => { n++; console.log(`  ok ${m}`); };
const diffOf = async (content, edit) => {
  const f = path.join(dir, `f${n}.txt`);
  writeFileSync(f, content);
  const r = await omegaEdit({ dryRun: true, edits: [{ path: f, ...edit }] });
  assert.ok(!r.isError, r.text);
  return r.text;
};

{ // mid-line replacement: full old line on "-"
  const t = await diffOf('a\n  return x + 1;\nb\n', { oldString: 'x + 1', newString: 'x + 100' });
  assert.match(t, /^- {3}return x \+ 1;$/m); assert.match(t, /^\+ {3}return x \+ 100;$/m);
  ok('mid-line: full old line shown');
}
{ // whole-line replacement ending in newline: no phantom blank "-" line
  const t = await diffOf('one\ntwo\nthree\n', { oldString: 'two\n', newString: 'TWO\n' });
  assert.match(t, /^- two$/m); assert.match(t, /^\+ TWO$/m);
  assert.doesNotMatch(t, /^- $/m);
  ok('whole line: no phantom blank line');
}
{ // multi-line old, single-line new
  const t = await diffOf('a\nb\nc\nd\n', { oldString: 'b\nc', newString: 'BC' });
  assert.match(t, /^- b$/m); assert.match(t, /^- c$/m); assert.match(t, /^\+ BC$/m);
  ok('multi-line old, one-line new');
}
{ // deletion (empty newString) keeps the surrounding text on the old line
  const t = await diffOf('keep DELETE_ME end\n', { oldString: 'DELETE_ME ', newString: '' });
  assert.match(t, /^- keep DELETE_ME end$/m); assert.match(t, /^\+ keep end$/m);
  ok('deletion shows full old and new line');
}
console.log(`EDIT_DIFF_OK ${n}`);
process.exit(0);
