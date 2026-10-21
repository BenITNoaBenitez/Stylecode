import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { validateCatalog, priceParams, linkParams, provision } from '../scripts/prepare-stripe.mjs';

const catalog = JSON.parse(await readFile(new URL('../payments/catalog.json', import.meta.url), 'utf8'));
const runtime = await readFile(new URL('../payments/checkout.js', import.meta.url), 'utf8');
const bookingSource = await readFile(new URL('../bookings/config.js', import.meta.url), 'utf8');
const bookingWindow = {};
vm.runInNewContext(bookingSource, { window: bookingWindow });
const bookings = bookingWindow.STYLECODE_BOOKING_CONFIG;
function checkout(config, hostname = 'localhost', protocol = 'http:', bookingConfig) {
  const window = { STYLECODE_PAYMENT_CONFIG: config, STYLECODE_BOOKING_CONFIG: bookingConfig, location: { hostname, protocol } };
  vm.runInNewContext(runtime, { window, URL });
  return window.StylecodeCheckout;
}

test('all displayed tariffs are euro cents, with 8 products and 11 distinct variants', () => {
  validateCatalog(catalog);
  assert.equal(catalog.products.length, 8);
  const variants = catalog.products.flatMap(p => p.variants);
  assert.equal(variants.length, 11);
  assert.deepEqual(Object.fromEntries(variants.map(v => [v.id, v.amount ?? v.minimum])), {
    stylecode_visio: 16000, stylecode_presentiel: 18000,
    morphologie_visio: 16000, morphologie_presentiel: 18000,
    colorimetrie_visio: 6900, colorimetrie_presentiel: 8500,
    moodboard: 6000, dressing: 9000, pack_decouverte: 20000,
    pack_stylecode: 45000, carte_cadeau: 100
  });
  assert.equal(catalog.products.filter(p => p.priceConfirmationRequired).length, 4);
});

test('missing and disabled links preserve email reservation without claiming payment is available', () => {
  for (const config of [undefined, { mode: 'disabled' }, { mode: 'live', links: {} }]) {
    const result = checkout(config).offer('moodboard', 'mailto:natalia@example.com', 'Payer', 'Réserver');
    assert.equal(result.href, 'mailto:natalia@example.com');
    assert.equal(result.label, 'Réserver');
    assert.equal(result.ready, false);
  }
});

test('live link keeps variant identity and switches to the payment label', () => {
  const config = { mode: 'live', links: { stylecode_visio: 'https://buy.stripe.com/example123' } };
  const result = checkout(config, 'stylecode.fr').offer('stylecode_visio', 'mailto:natalia@example.com', 'Payer en visio · 160 €', 'Réserver');
  const url = new URL(result.href);
  assert.equal(url.hostname, 'buy.stripe.com');
  assert.equal(url.searchParams.get('client_reference_id'), 'stylecode_stylecode_visio');
  assert.equal(url.searchParams.get('locale'), 'fr');
  assert.equal(result.label, 'Payer en visio · 160 €');
  assert.equal(result.ready, true);
});

test('test links never activate on the public site or with a live configuration', () => {
  const config = { mode: 'test', links: { moodboard: 'https://buy.stripe.com/test_example123' } };
  assert.equal(checkout(config, 'stylecode.fr').offer('moodboard', 'mailto:x', 'Pay', 'Reserve').ready, false);
  assert.equal(checkout(config).offer('moodboard', 'mailto:x', 'Pay', 'Reserve').ready, true);
  assert.equal(checkout(config, '', 'file:').offer('moodboard', 'mailto:x', 'Pay', 'Reserve').ready, true);
  assert.equal(checkout({ ...config, mode: 'live' }).offer('moodboard', 'mailto:x', 'Pay', 'Reserve').ready, false);
  assert.equal(checkout({ mode: 'test', links: { moodboard: 'https://buy.stripe.com/example123' } }).offer('moodboard', 'mailto:x', 'Pay', 'Reserve').ready, false);
});

test('reject executable URLs, lookalike domains, credentials and non-Stripe hosts', () => {
  for (const url of ['javascript:alert(1)', 'http://buy.stripe.com/example123', 'https://buy.stripe.com.evil.example/example123', 'https://evil.example/buy.stripe.com', 'https://user:password@buy.stripe.com/example123', 'https://buy.stripe.com:444/example123', 'https://buy.stripe.com/', 'https://buy.stripe.com/example123#hidden']) {
    assert.equal(checkout({ mode: 'live', links: { moodboard: url } }).offer('moodboard', 'mailto:x', 'Pay', 'Reserve').ready, false, url);
  }
});

test('gift price is editable on Stripe, not an arbitrary fixed value or subscription', () => {
  const product = catalog.products.find(p => p.id === 'carte_cadeau');
  const variant = product.variants[0];
  const price = priceParams('prod_gift', variant, 'eur');
  assert.equal(price['custom_unit_amount[enabled]'], 'true');
  assert.equal(price['custom_unit_amount[minimum]'], 100);
  assert.equal(price.unit_amount, undefined);
  const link = linkParams('price_gift', product, variant);
  assert.equal(link['line_items[0][quantity]'], 1);
  assert.equal(link['payment_method_types[0]'], 'card');
  assert(!Object.keys(link).some(k => k.includes('subscription')));
  assert.equal(link['after_completion[type]'], 'hosted_confirmation');
});

test('provision all variants once and resume from saved state without creating duplicates', async () => {
  const calls = [];
  const state = {};
  let saved;
  const request = async (path, params) => {
    calls.push({ path, params });
    return { id: `id_${calls.length}`, url: `https://buy.stripe.com/test_example${calls.length}` };
  };
  const links = await provision(catalog, state, request, async value => { saved = structuredClone(value); });
  assert.equal(Object.keys(links).length, 11);
  assert.equal(calls.filter(c => c.path === '/products').length, 8);
  assert.equal(calls.filter(c => c.path === '/prices').length, 11);
  assert.equal(calls.filter(c => c.path === '/payment_links').length, 11);
  const second = await provision(catalog, saved, async () => { throw new Error('Unexpected duplicate request'); }, async () => {});
  assert.deepEqual(second, links);
});

test('an interruption after a price is saved resumes at its payment link', async () => {
  const small = { ...catalog, products: [catalog.products[0]] };
  const state = {};
  let calls = 0;
  await assert.rejects(provision(small, state, async () => {
    if (++calls === 3) throw new Error('connection interrupted');
    return { id: `id_${calls}` };
  }, async () => {}), /interrupted/);
  assert.equal(state.products.stylecode, 'id_1');
  assert.equal(state.variants.stylecode_visio.priceId, 'id_2');
  const paths = [];
  await provision(small, state, async path => {
    paths.push(path); return { id: 'resumed', url: `https://buy.stripe.com/test_resume${paths.length}` };
  }, async () => {});
  assert.deepEqual(paths, ['/payment_links', '/prices', '/payment_links']);
});

test('invalid prices and duplicate variants are rejected before any Stripe call', () => {
  const invalid = structuredClone(catalog);
  invalid.products[0].variants[0].amount = 160.5;
  assert.throws(() => validateCatalog(invalid), /cents/);
  const duplicate = structuredClone(catalog);
  duplicate.products[0].variants[1].id = duplicate.products[0].variants[0].id;
  assert.throws(() => validateCatalog(duplicate), /duplicate/);
});

test('each configured service books its own Cal.com event, ahead of standalone Stripe checkout', () => {
  const routes = {
    stylecode_visio: 'stylecode-decodez-votre-style-en-ligne',
    stylecode_presentiel: 'decodez-votre-style',
    morphologie_visio: 'morphologie-visagisme-en-ligne',
    morphologie_presentiel: 'morphologie-visagisme',
    colorimetrie_visio: 'colorimetrie',
    colorimetrie_presentiel: 'colorimetrie-en-presentiel',
    moodboard: 'moodboard-stylecode',
    dressing: 'edition-de-dressing',
    pack_decouverte: 'pack-decouverte',
    pack_stylecode: 'pack-stylecode'
  };
  for (const [id, slug] of Object.entries(routes)) {
    const client = checkout({ mode: 'live', links: { [id]: 'https://buy.stripe.com/example123' } }, 'stylecode.fr', 'https:', bookings);
    const result = client.offer(id, 'mailto:x', 'Payer', 'Réserver');
    assert.equal(result.href, `https://cal.com/natalia-ventura-stylecode/${slug}`);
    assert.equal(result.label, 'Réserver');
    assert.equal(result.ready, true);
  }
});

test('gift purchases do not use the free gift calendar', () => {
  const client = checkout({ mode: 'disabled' }, 'stylecode.fr', 'https:', bookings);
  for (const id of ['carte_cadeau']) {
    const result = client.offer(id, 'mailto:natalia@example.com', 'Payer', 'Réserver');
    assert.equal(result.href, 'mailto:natalia@example.com', id);
    assert.equal(result.ready, false, id);
  }
  assert.equal(client.businessUrl(bookings), 'https://cal.com/natalia-ventura-stylecode/30min');
});

test('Cal.com configuration rejects redirects, invalid slugs and disabled booking', () => {
  const client = checkout({ mode: 'disabled' });
  for (const config of [
    { ...bookings, enabled: false },
    { ...bookings, username: 'user/../../other' },
    { ...bookings, events: { moodboard: 'https://example.com' } },
    { ...bookings, events: { moodboard: 'moodboard?redirect=example.com' } }
  ]) assert.equal(client.bookingUrl('moodboard', config), null);
});
