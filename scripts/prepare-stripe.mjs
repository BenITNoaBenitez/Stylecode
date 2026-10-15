import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateCatalog(catalog) {
  if (catalog.currency !== 'eur' || !Number.isInteger(catalog.version) || !Array.isArray(catalog.products)) throw new Error('Invalid catalog.');
  const ids = new Set();
  for (const product of catalog.products) {
    if (!product.id || !product.name || !product.variants?.length) throw new Error('Incomplete product.');
    for (const variant of product.variants) {
      if (!/^[a-z0-9_]+$/.test(variant.id) || ids.has(variant.id)) throw new Error('Invalid or duplicate variant.');
      ids.add(variant.id);
      const amount = variant.amount ?? variant.minimum;
      if (!Number.isInteger(amount) || amount < 100 || (variant.amount != null && variant.minimum != null)) throw new Error('Amounts must be positive euro cents.');
    }
  }
  return catalog;
}

export function priceParams(productId, variant, currency) {
  const params = { product: productId, currency, nickname: variant.name, 'metadata[stylecode_variant]': variant.id };
  if (variant.amount != null) params.unit_amount = variant.amount;
  else {
    params['custom_unit_amount[enabled]'] = 'true';
    params['custom_unit_amount[minimum]'] = variant.minimum;
  }
  return params;
}

export function linkParams(priceId, product, variant) {
  return {
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    'payment_method_types[0]': 'card',
    'metadata[stylecode_product]': product.id,
    'metadata[stylecode_variant]': variant.id,
    'payment_intent_data[metadata][stylecode_variant]': variant.id,
    'custom_text[submit][message]': `${product.name} · ${variant.name}. ${variant.minimum ? 'Le montant payé correspond à la valeur de votre carte cadeau.' : 'La date de la séance est à convenir avec Natalia.'}`,
    'after_completion[type]': 'hosted_confirmation',
    'after_completion[hosted_confirmation][custom_message]': 'Merci pour votre achat Stylecode. Contactez Natalia à ventura.stylecode@gmail.com pour organiser votre séance ou votre carte cadeau.'
  };
}

export async function provision(catalog, state, request, save) {
  validateCatalog(catalog);
  state.products ??= {};
  state.variants ??= {};
  const links = {};
  for (const product of catalog.products) {
    if (!state.products[product.id]) {
      const result = await request('/products', { name: product.name, 'metadata[stylecode_product]': product.id });
      state.products[product.id] = result.id;
      await save(state);
    }
    for (const variant of product.variants) {
      const entry = state.variants[variant.id] ??= {};
      if (!entry.priceId) {
        const result = await request('/prices', priceParams(state.products[product.id], variant, catalog.currency));
        entry.priceId = result.id;
        await save(state);
      }
      if (!entry.url) {
        const result = await request('/payment_links', linkParams(entry.priceId, product, variant));
        if (typeof result.url !== 'string' || !/^https:\/\/(buy|book)\.stripe\.com\//.test(result.url)) throw new Error('Unexpected Stripe Payment Link response.');
        entry.linkId = result.id;
        entry.url = result.url;
        await save(state);
      }
      links[variant.id] = entry.url;
    }
  }
  return links;
}

async function atomicWrite(path, content) {
  await writeFile(path + '.tmp', content, { mode: 0o600 });
  await rename(path + '.tmp', path);
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--apply', '--live', '--prices-confirmed']);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Usage: node scripts/prepare-stripe.mjs [--apply] [--live --prices-confirmed]');
  const catalog = validateCatalog(JSON.parse(await readFile(resolve(root, 'payments/catalog.json'), 'utf8')));
  const mode = args.includes('--live') ? 'live' : 'test';
  const plan = catalog.products.flatMap(p => p.variants.map(v => ({ product: p.name, variant: v.name, id: v.id, amount: v.amount != null ? `${(v.amount / 100).toFixed(2)} EUR` : `Montant libre, minimum ${(v.minimum / 100).toFixed(2)} EUR`, priceConfirmationRequired: Boolean(p.priceConfirmationRequired) })));
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ mode, action: 'preview_only', products: catalog.products.length, paymentLinks: plan.length, plan }, null, 2));
    return;
  }
  if (mode === 'live' && !args.includes('--prices-confirmed')) throw new Error('Confirm prices for the four “à partir de” offers before live setup: --prices-confirmed.');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !new RegExp(`^(sk|rk)_${mode}_`).test(key)) throw new Error(`STRIPE_SECRET_KEY must be a ${mode} secret or restricted key.`);
  const fingerprint = hash(catalog);
  const directory = resolve(root, '.stripe');
  const statePath = resolve(directory, `${mode}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { fingerprint, mode }; }
  if (state.fingerprint !== fingerprint || state.mode !== mode) throw new Error('Catalog changed: review the existing Stripe objects before creating new prices.');
  const request = async (path, params) => {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method: params ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `stylecode-${mode}-${hash({ fingerprint, path, params })}` } : {})
      },
      body: params ? new URLSearchParams(params).toString() : undefined,
      signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`Stripe ${response.status}: ${result.error?.code || result.error?.type || 'request_failed'} (${path}).`);
    return result;
  };
  const account = await request('/account');
  if (state.accountId && state.accountId !== account.id) throw new Error('The key belongs to a different Stripe account.');
  state.accountId = account.id;
  const save = value => atomicWrite(statePath, JSON.stringify(value, null, 2) + '\n');
  await save(state);
  const links = await provision(catalog, state, request, save);
  const configuration = `// Public Stripe Payment Links. No API keys.\nwindow.STYLECODE_PAYMENT_CONFIG = ${JSON.stringify({ mode, links }, null, 2)};\n`;
  await atomicWrite(resolve(root, 'payments/config.js'), configuration);
  console.log(`Prepared ${Object.keys(links).length} ${mode} Payment Links in payments/config.js. ${mode === 'test' ? 'Test links only activate on localhost or file previews.' : 'Review and deploy the public configuration to activate payments.'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
