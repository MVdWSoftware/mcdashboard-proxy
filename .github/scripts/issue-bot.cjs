// Copyright (c) 2026 MVdW-Software
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Issue bot: validates new issues, labels the good ones `accepted` and forwards them (and their
// comments) to the MVdW helpdesk. Runs from .github/workflows/issue-bot.yml. Pure checks are
// exported for the tests; nothing here executes issue content.
'use strict';
const crypto = require('node:crypto');

const MARKER = '<!-- mvdw-helpdesk -->';
const BOT_MARKER = '<!-- issue-bot -->';
const LABELS = {
  accepted: ['0e8a16', 'Validated and forwarded to the helpdesk'],
  'needs-info': ['d93f0b', 'Waiting for the reporter to fix the issue form'],
  invalid: ['e4e669', 'Not about this component'],
};
const SECRET_PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/github_pat_[A-Za-z0-9_]{40,}/, 'a GitHub token'],
  [/glpat-[A-Za-z0-9_-]{15,}/, 'a GitLab token'],
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JWT / access token'],
  [
    /\b(?:TUNNEL_TOKEN|EVENTS_TOKEN|MCD_JWT_SECRET|WEBHOOK_SECRET|REDIS_PASSWORD|tunnel[._-]?key)\s*[:=]\s*["']?[^\s"'<>]{12,}/i,
    'a secret value from the configuration',
  ],
  [/\b(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["']?(?!REDACTED|\*+|x{3,}|<)[^\s"'<>]{8,}/i, 'a password or key'],
];

/**
 * Splits an issue-form body into its sections (`### Heading` then the answer).
 * @param {string} body - The issue body.
 * @returns {Map<string,string>} Heading to answer.
 */
function sections(body) {
  const map = new Map();
  let current = null;
  for (const line of String(body || '').replace(/\r/g, '').split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      map.set(current, '');
    } else if (current !== null) {
      map.set(current, `${map.get(current)}${line}\n`);
    }
  }
  for (const [key, value] of map) map.set(key, value.trim());
  return map;
}

/**
 * Checks an issue against its form.
 * @param {{title: string, body: string|null}} issue - The issue.
 * @param {string[]} required - Section headings that must be filled in.
 * @returns {string[]} What is wrong (empty = valid).
 */
function validate(issue, required) {
  const problems = [];
  const body = issue.body || '';
  const parts = sections(body);
  if (parts.size === 0) {
    return ['Please use the issue form (the description is empty or the form fields are missing).'];
  }
  const scope = parts.get('Scope') || '';
  if ((scope.match(/- \[[xX]\]/g) || []).length < 2) {
    problems.push('Please tick both boxes under **Scope**, so we know this is about this component.');
  }
  for (const heading of required) {
    const answer = (parts.get(heading) || '').trim();
    if (answer === '' || /^_?No response_?$/i.test(answer)) {
      problems.push(`Please fill in **${heading}**.`);
    }
  }
  if (String(issue.title || '').trim().length < 5) problems.push('Please give the issue a descriptive title.');
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(`${issue.title}\n${body}`)) {
      problems.push(
        `The issue seems to contain ${what}. Remove it, and **treat it as leaked: rotate it** (the edit history stays visible).`,
      );
      break;
    }
  }
  return problems;
}

/**
 * The HMAC envelope the helpdesk expects.
 * @param {string} secret - The shared secret.
 * @param {object} payload - The message.
 * @param {number} [now] - Unix seconds.
 * @returns {{timestamp: number, payload: string, signature: string}} The envelope.
 */
function sign(secret, payload, now = Math.floor(Date.now() / 1000)) {
  const text = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${now}.${text}`).digest('hex');
  return { timestamp: now, payload: text, signature };
}

/**
 * The form fields that must be filled in: a bug report (label `bug`, set by the form) or a feature request.
 * @param {string[]} labels - The label names.
 * @param {string[]} [bugFields] - Extra required fields of the bug form (this repository's version fields).
 * @returns {string[]} The required headings.
 */
function requiredFor(labels, bugFields = []) {
  return labels.includes('bug')
    ? ['What happened, and what did you expect?', 'Steps to reproduce', ...bugFields]
    : ['Problem', 'Proposed solution'];
}

/**
 * Entry point of the workflow.
 * @param {object} ctx - `{ github, context, core, env }` from actions/github-script.
 * @returns {Promise<void>} Resolves when done.
 */
async function run({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const issue = context.payload.issue;
  if (!issue || issue.pull_request) return;
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  const url = env.HELPDESK_WEBHOOK_URL;
  const secret = env.HELPDESK_WEBHOOK_SECRET;
  const forwarding = Boolean(url && secret);
  const post = async (message) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sign(secret, message)),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Helpdesk answered ${response.status}`);
  };
  const base = {
    repo: `${owner}/${repo}`,
    number: issue.number,
    url: issue.html_url,
  };

  if (context.eventName === 'issue_comment') {
    const comment = context.payload.comment;
    if (!labels.includes('accepted') || !forwarding) return;
    if (comment.user.type === 'Bot' || String(comment.body).includes(MARKER)) return;
    await post({ event: 'comment', ...base, author: comment.user.login, commentId: comment.id, body: String(comment.body).slice(0, 20000) });
    return;
  }

  if (labels.includes('accepted')) return; // already forwarded; later edits are not forwarded
  if (issue.user.type === 'Bot') return;
  for (const [name, [color, description]] of Object.entries(LABELS)) {
    try {
      await github.rest.issues.createLabel({ owner, repo, name, color, description });
    } catch (error) {
      if (error.status !== 422) throw error; // 422: it exists already
    }
  }
  const bugFields = (env.ISSUE_BOT_BUG_FIELDS || '').split(',').map((f) => f.trim()).filter(Boolean);
  const problems = validate(issue, requiredFor(labels, bugFields));
  const scopeOnly = problems.some((p) => p.includes('**Scope**'));
  const say = async (text) =>
    github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: `${text}\n\n${BOT_MARKER}` });
  const existing = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: issue.number, per_page: 100 });
  const alreadyTold = existing.some((c) => c.body.includes(BOT_MARKER));

  if (problems.length > 0) {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [scopeOnly ? 'invalid' : 'needs-info'] });
    if (!alreadyTold || context.payload.action === 'edited') {
      await say(
        `Thanks for the report. Before we can pick this up:\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\n` +
          'Edit the issue to fix this and the bot checks it again. This tracker is only for this component; ' +
          'for the app, the portal, licences or billing contact https://mcdashboard.org/en/support/.',
      );
    }
    return;
  }

  for (const stale of ['needs-info', 'invalid']) {
    if (labels.includes(stale)) await github.rest.issues.removeLabel({ owner, repo, issue_number: issue.number, name: stale });
  }
  if (!forwarding) {
    core.notice('HELPDESK_WEBHOOK_URL/HELPDESK_WEBHOOK_SECRET not set: validated only, not forwarded.');
    return;
  }
  await post({ event: 'issue', ...base, author: issue.user.login, title: issue.title, body: String(issue.body).slice(0, 20000) });
  await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: ['accepted'] });
  await say('Thanks, this looks complete. It was added to our helpdesk; replies from the team appear here.');
}

module.exports = run;
module.exports.validate = validate;
module.exports.sections = sections;
module.exports.sign = sign;
module.exports.requiredFor = requiredFor;
module.exports.MARKER = MARKER;
