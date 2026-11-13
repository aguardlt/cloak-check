import test from 'node:test';
import assert from 'node:assert/strict';
import { registrable, extractTitle, stripToText, tokens, jaccard, externalHosts, findSpam, summarize, compare, looksBlocked, worst } from '../extension/lib/analyze.js';

const page = (title, body) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const shop = page('Organic carrots | Farm shop', '<h1>Fresh carrots</h1><p>We grow organic vegetables and deliver them every week to your door in the city.</p><a href="https://facebook.com/farm">fb</a><a href="/about">About</a>');
const spam = page('Best online casino bonus 2026', '<h1>Top 10 casino</h1><p>Play slots and poker with jackpot bonus today.</p><a href="https://a-casino.com/">1</a><a href="https://b-bets.net">2</a><a href="https://c-slots.org/x">3</a>');
const res = (html, extra = {}) => summarize({ url: 'https://shop.example/', finalUrl: 'https://shop.example/', status: 200, html, ...extra });

test('registrable domain', () => {
  assert.equal(registrable('www.example.com'), 'example.com');
  assert.equal(registrable('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('127.0.0.1'), '127.0.0.1');
  assert.equal(registrable('localhost'), 'localhost');
});

test('html helpers', () => {
  assert.equal(extractTitle('<TITLE>\n A &amp; B </TITLE>'), 'A & B');
  assert.equal(stripToText('<p>Hi<script>var x="<b>no</b>"</script> there</p><style>p{}</style>'), 'Hi there');
  assert.ok(tokens('Ūkis ir morkos 2026').has('morkos'));
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.deepEqual([...externalHosts(shop, 'https://shop.example/')], ['facebook.com']);
  assert.deepEqual([...findSpam('Online Casino and viagra')].sort(), ['casino', 'viagra']);
});

test('identical page is ok', () => {
  const c = compare(res(shop), res(shop));
  assert.equal(c.level, 'ok');
  assert.equal(c.similarity, 1);
});

test('cloaked spam page is flagged', () => {
  const c = compare(res(shop), res(spam));
  assert.equal(c.level, 'bad');
  assert.ok(c.notes.some((n) => n.includes('different page')));
  assert.ok(c.notes.some((n) => n.includes('Spam keywords')));
  assert.equal(c.newHosts.length, 3);
});

test('firewall block is inconclusive, not an alert', () => {
  const blocked = res(page('Just a moment...', 'Checking your browser'), { status: 403 });
  assert.ok(looksBlocked(blocked));
  assert.equal(compare(res(shop), blocked).level, 'info');
});

test('redirect to another site is flagged', () => {
  const moved = res(shop, { finalUrl: 'https://pills.example.net/' });
  assert.equal(compare(res(shop), moved).level, 'bad');
  const hidden = { url: 'https://shop.example/', error: 'redirect', crossRedirect: true };
  assert.equal(compare(res(shop), summarize(hidden)).level, 'bad');
});

test('a page that changes by itself does not raise an alert', () => {
  const a = res(page('News', '<p>' + 'alpha beta gamma delta epsilon zeta eta theta '.repeat(3) + 'one two three</p>'));
  const b = res(page('News', '<p>' + 'alpha beta gamma delta epsilon zeta eta theta '.repeat(3) + 'four five six seven</p>'));
  assert.equal(compare(a, b, jaccard(a.tokens, b.tokens)).level, 'ok');
});

test('worst level', () => assert.equal(worst(['ok', 'warn', 'info']), 'warn'));
