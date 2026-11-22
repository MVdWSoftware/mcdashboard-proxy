'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const run = require('./issue-bot.cjs');
const { validate, sections, sign, requiredFor } = run;

const form = (scope, extra = '') =>
  `### Scope\n\n${scope}\n\n### Problem\n\nI cannot do X.\n\n### Proposed solution\n\nAllow X.\n\n${extra}`;
const ticked = '- [x] This is about the plugin.\n- [X] I searched.';

test('sections splits an issue form', () => {
  const parts = sections(form(ticked));
  assert.equal(parts.get('Problem'), 'I cannot do X.');
  assert.equal(sections('free text').size, 0);
});

test('a complete feature request is valid', () => {
  assert.deepEqual(validate({ title: 'Allow X', body: form(ticked) }, requiredFor([])), []);
});

test('unticked scope, empty fields and short titles are reported', () => {
  const problems = validate({ title: 'x', body: form('- [ ] a\n- [x] b').replace('I cannot do X.', '_No response_') }, requiredFor([]));
  assert.equal(problems.length, 3);
  assert.match(problems.join(' '), /Scope/);
  assert.match(problems.join(' '), /Problem/);
});

test('an issue without the form is reported', () => {
  assert.match(validate({ title: 'Help me', body: null }, [])[0], /issue form/);
});

test('bug forms require the repository version fields', () => {
  const body = `${form(ticked)}\n### What happened, and what did you expect?\n\nIt breaks.\n\n### Steps to reproduce\n\n1. start\n\n### Plugin version\n\n_No response_`;
  const required = requiredFor(['bug'], ['Plugin version']);
  assert.deepEqual(validate({ title: 'It breaks', body }, required).length, 1);
});

test('secrets are detected', () => {
  for (const secret of [
    'token ghp_' + 'a'.repeat(36),
    'AKIA' + 'A'.repeat(16),
    '-----BEGIN PRIVATE KEY-----',
    'TUNNEL_TOKEN=' + 'q'.repeat(40),
    'password: hunter2hunter2',
  ]) {
    const problems = validate({ title: 'Valid title', body: form(ticked, secret) }, requiredFor([]));
    assert.ok(problems.some((p) => p.includes('rotate')), secret);
  }
  assert.deepEqual(validate({ title: 'Valid title', body: form(ticked, 'password: REDACTED') }, requiredFor([])), []);
});

test('sign matches the helpdesk scheme', () => {
  const envelope = sign('s'.repeat(40), { a: 1 }, 1_800_000_000);
  const expected = crypto.createHmac('sha256', 's'.repeat(40)).update(`1800000000.${envelope.payload}`).digest('hex');
  assert.equal(envelope.signature, expected);
  assert.equal(envelope.payload, '{"a":1}');
});

/** A fake octokit that records what the bot does. */
function fakeGithub(comments = []) {
  const calls = { labels: [], removed: [], comments: [] };
  const rest = {
    issues: {
      createLabel: async () => ({}),
      addLabels: async ({ labels }) => calls.labels.push(...labels),
      removeLabel: async ({ name }) => calls.removed.push(name),
      createComment: async ({ body }) => calls.comments.push(body),
      listComments: 'listComments',
    },
  };
  return { calls, github: { rest, paginate: async () => comments } };
}
const ctx = (issue, extra = {}) => ({
  repo: { owner: 'MVdWSoftware', repo: 'mcdashboard-plugin' },
  eventName: 'issues',
  payload: { action: 'opened', issue: { number: 7, html_url: 'https://github.com/MVdWSoftware/mcdashboard-plugin/issues/7', user: { login: 'octocat', type: 'User' }, labels: [], ...issue }, ...extra },
});
const env = { HELPDESK_WEBHOOK_URL: 'https://portal.example.com/api/support/hooks/github-issues', HELPDESK_WEBHOOK_SECRET: 's'.repeat(40) };

test('a valid issue is forwarded signed, then labelled accepted', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  try {
    const { github, calls } = fakeGithub();
    await run({ github, context: ctx({ title: 'Allow X', body: form(ticked) }), core: { notice() {} }, env });
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0].body.payload).event, 'issue');
    assert.deepEqual(calls.labels, ['accepted']);
  } finally { global.fetch = realFetch; }
});

test('an invalid issue is labelled and answered, not forwarded', async () => {
  const { github, calls } = fakeGithub();
  await run({ github, context: ctx({ title: 'Allow X', body: form('- [ ] a\n- [ ] b') }), core: { notice() {} }, env });
  assert.deepEqual(calls.labels, ['invalid']);
  assert.match(calls.comments[0], /Scope/);
});

test('without webhook settings it only validates', async () => {
  const notices = [];
  const { github, calls } = fakeGithub();
  await run({ github, context: ctx({ title: 'Allow X', body: form(ticked) }), core: { notice: (m) => notices.push(m) }, env: {} });
  assert.equal(calls.labels.length, 0);
  assert.equal(notices.length, 1);
});

test('comments on accepted issues are forwarded, the bridge\'s own are not', async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => { sent.push(JSON.parse(JSON.parse(init.body).payload)); return { ok: true, status: 200 }; };
  try {
    const { github } = fakeGithub();
    const base = { eventName: 'issue_comment' };
    const labels = [{ name: 'accepted' }];
    await run({ github, context: { ...ctx({ labels }), ...base, payload: { ...ctx({ labels }).payload, comment: { id: 5, body: 'Same here', user: { login: 'a', type: 'User' } } } }, core: {}, env });
    await run({ github, context: { ...ctx({ labels }), ...base, payload: { ...ctx({ labels }).payload, comment: { id: 6, body: `Fixed\n${run.MARKER}`, user: { login: 'b', type: 'User' } } } }, core: {}, env });
    await run({ github, context: { ...ctx({}), ...base, payload: { ...ctx({}).payload, comment: { id: 7, body: 'x', user: { login: 'c', type: 'User' } } } }, core: {}, env });
    assert.deepEqual(sent.map((m) => [m.event, m.commentId]), [['comment', 5]]);
  } finally { global.fetch = realFetch; }
});
