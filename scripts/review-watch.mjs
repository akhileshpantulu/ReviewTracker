#!/usr/bin/env node
/**
 * Watches one hotel's Bazaarvoice review count and opens a GitHub issue
 * whenever it changes. GitHub emails the issue to the repo owner (issues are
 * assigned to them), so no mail account or SMTP server is involved.
 *
 * Runs inside .github/workflows/review-watch.yml on an hourly cron. State is
 * kept in .state/review-watch.json and committed back by the workflow, so a
 * run only sees changes since the last committed check.
 *
 * Uses the same public Marriott Bonvoy display passkey that docs/index.html
 * ships to every visitor.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PASSKEY = 'canCX9lvC812oa4Y6HYf4gmWK5uszkZCKThrdtYkZqcYE';
const HOTEL_LABEL = 'Moxy Paris La Villette';
const HOTEL_TOKENS = ['moxy', 'villette']; // catalog name must contain all of these
const STATE_PATH = '.state/review-watch.json';
const MAX_REVIEWS_IN_ISSUE = 5;
const DASHBOARD_URL = 'https://akhileshpantulu.github.io/ReviewTracker/';

const BV_API = 'https://api.bazaarvoice.com/data';
const GH_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const OWNER = REPO ? REPO.split('/')[0] : null;
const TOKEN = process.env.GH_TOKEN;

/* ---------- Bazaarvoice ---------- */

async function bvGet(resource, params) {
  const url = new URL(`${BV_API}/${resource}`);
  url.searchParams.set('passkey', PASSKEY);
  url.searchParams.set('apiversion', '5.5');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Bazaarvoice ${resource} HTTP ${r.status}`);
  const j = await r.json();
  if (j.HasErrors) throw new Error(`Bazaarvoice ${resource}: ${JSON.stringify(j.Errors)}`);
  return j;
}

function pickMatch(results = []) {
  return results.find(p => {
    if (p.Disabled === true) return false;
    const name = (p.Name || '').toLowerCase();
    return HOTEL_TOKENS.every(t => name.includes(t));
  });
}

async function findProduct() {
  // Try a text search first (one request); fall back to scanning the
  // paginated catalog. Either way this runs once — the ID is cached in state.
  try {
    const j = await bvGet('products.json', { Search: HOTEL_TOKENS.join(' '), Limit: 100 });
    const hit = pickMatch(j.Results);
    if (hit) return hit;
  } catch { /* Search unsupported or errored — scan instead */ }
  for (let offset = 0; ; offset += 100) {
    const j = await bvGet('products.json', { Limit: 100, Offset: offset });
    const hit = pickMatch(j.Results);
    if (hit) return hit;
    if (!j.Results?.length || offset + 100 >= (j.TotalResults || 0)) break;
  }
  throw new Error(`No catalog entry matches "${HOTEL_TOKENS.join(' ')}" — hotel renamed or delisted?`);
}

async function getStats(productId) {
  const j = await bvGet('products.json', { Filter: `Id:${productId}`, Stats: 'Reviews' });
  const p = j.Results?.[0];
  if (!p) throw new Error(`Product ${productId} no longer in catalog`);
  const s = p.ReviewStatistics || {};
  return {
    count: s.TotalReviewCount ?? 0,
    avg: s.AverageOverallRating != null ? Number(s.AverageOverallRating.toFixed(2)) : null,
    name: p.Name || HOTEL_LABEL,
  };
}

async function latestReviews(productId, n) {
  const j = await bvGet('reviews.json', {
    Filter: `ProductId:${productId}`,
    Sort: 'SubmissionTime:desc',
    Limit: String(Math.min(Math.max(n, 1), MAX_REVIEWS_IN_ISSUE)),
  });
  return (j.Results || []).map(r => ({
    rating: r.Rating,
    title: r.Title || '(no title)',
    text: r.ReviewText || '',
    date: (r.SubmissionTime || '').slice(0, 10),
    by: r.UserNickname || 'anonymous',
  }));
}

/* ---------- GitHub ---------- */

async function ghRequest(method, path, body) {
  const r = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function openIssue(title, body) {
  // Label is cosmetic — create it if missing, ignore "already exists".
  await ghRequest('POST', `/repos/${REPO}/labels`, { name: 'new-review', color: '1d76db' });
  const r = await ghRequest('POST', `/repos/${REPO}/issues`, {
    title,
    body,
    assignees: OWNER ? [OWNER] : [],
    labels: ['new-review'],
  });
  if (!r.ok) throw new Error(`Issue creation failed: HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  console.log(`Opened issue #${j.number}: ${title}`);
}

/* ---------- formatting ---------- */

const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);

function formatReview(r) {
  const text = r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text;
  const quoted = text ? text.split('\n').map(l => `> ${l}`).join('\n') : '> _(no review text)_';
  return `### ${stars(r.rating)} ${r.rating}/5 — “${r.title}”\n_by ${r.by} · ${r.date}_\n\n${quoted}`;
}

function issueFooter(productId) {
  return `\n\n---\n[Dashboard](${DASHBOARD_URL}) · Product \`${productId}\` · Checked hourly by \`review-watch.yml\``;
}

/* ---------- state ---------- */

function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/* ---------- main ---------- */

async function main() {
  const state = readState();

  let productId = state?.productId;
  if (!productId) {
    const p = await findProduct();
    productId = p.Id;
    console.log(`Resolved "${HOTEL_LABEL}" to product ${productId} (${p.Name})`);
  }

  const stats = await getStats(productId);
  const prev = state?.totalReviewCount;

  if (state == null || !state.productId) {
    // First run: record the baseline and send a confirmation issue so the
    // email pipeline is verified end-to-end before a real review arrives.
    writeState({
      productId,
      productName: stats.name,
      totalReviewCount: stats.count,
      averageRating: stats.avg,
      updatedAt: new Date().toISOString(),
    });
    await openIssue(
      `Review watch started — ${HOTEL_LABEL}`,
      `Now watching **${stats.name}** (\`${productId}\`).\n\n` +
      `Baseline: **${stats.count} reviews**, average ${stats.avg != null ? `★${stats.avg}` : 'n/a'}. ` +
      `You'll get an issue like this one whenever the count changes.` +
      issueFooter(productId),
    );
    return;
  }

  if (stats.count === prev) {
    console.log(`No change (${stats.count} reviews).`);
    return;
  }

  const delta = stats.count - prev;
  const header =
    `**${stats.name}** review count changed: **${prev} → ${stats.count}**` +
    (stats.avg != null ? ` · average now ★${stats.avg}` : '');

  let title, body;
  if (delta > 0) {
    const reviews = await latestReviews(productId, delta);
    const shown = reviews.map(formatReview).join('\n\n');
    const more = delta > MAX_REVIEWS_IN_ISSUE ? `\n\n_…and ${delta - MAX_REVIEWS_IN_ISSUE} more not shown._` : '';
    title = delta === 1
      ? `New review — ${HOTEL_LABEL}: ${stars(reviews[0]?.rating ?? 0)} “${reviews[0]?.title ?? ''}”`
      : `${delta} new reviews — ${HOTEL_LABEL} (${prev} → ${stats.count})`;
    body = `${header}\n\n${shown}${more}${issueFooter(productId)}`;
  } else {
    title = `Review count decreased — ${HOTEL_LABEL} (${prev} → ${stats.count})`;
    body = `${header}\n\n${-delta} review(s) disappeared from the feed — usually moderation or guest deletion.${issueFooter(productId)}`;
  }

  await openIssue(title, body);
  writeState({
    productId,
    productName: stats.name,
    totalReviewCount: stats.count,
    averageRating: stats.avg,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
