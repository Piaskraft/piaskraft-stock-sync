// check-ean.js
require('dotenv').config();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const TEST_EAN = (process.env.TEST_EAN || '').trim();

if (!TEST_EAN) {
  console.error('Brak TEST_EAN w .env – ustaw TEST_EAN=... i spróbuj ponownie.');
  process.exit(1);
}

if (!process.env.PRESTA_URL || !process.env.PRESTA_API_KEY) {
  console.error('Brak PRESTA_URL lub PRESTA_API_KEY w .env');
  process.exit(1);
}

if (!process.env.FEED_URL) {
  console.error('Brak FEED_URL (CENEO) w .env.');
  process.exit(1);
}

if (!process.env.GOOGLE_FEED_URL) {
  console.error('Brak GOOGLE_FEED_URL (GOOGLE) w .env.');
  process.exit(1);
}

const presta = axios.create({
  baseURL: `${process.env.PRESTA_URL}/api`,
  auth: { username: process.env.PRESTA_API_KEY, password: '' },
  params: { output_format: 'JSON' },
  timeout: 15000,
});

function toInt(v) {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

async function checkInPresta() {
  console.log(`\n=== SPRAWDZAM W PREŚCIE EAN ${TEST_EAN} ===`);

  const res = await presta.get('/products', {
    params: {
      display: '[id,ean13]',
      'filter[ean13]': TEST_EAN,
    },
  });

  const products = res.data.products || [];

  if (!products.length) {
    console.log('W Preście brak produktu z tym EAN.');
    return;
  }

  for (const p of products) {
    console.log(`Znalazłem produkt: id=${p.id}, ean13=${p.ean13}`);

    const stockRes = await presta.get('/stock_availables', {
      params: {
        display: '[id,id_product,quantity]',
        'filter[id_product]': p.id,
      },
    });

    const stocks = stockRes.data.stock_availables || [];
    if (!stocks.length) {
      console.log('  Brak rekordu stock_availables dla tego produktu.');
    } else {
      const s = stocks[0];
      console.log(
        `  stock_availables: id=${s.id}, quantity=${s.quantity}`
      );
    }
  }
}

async function checkInCeneo() {
  console.log(`\n=== SPRAWDZAM W FEEDZIE CENEO EAN ${TEST_EAN} ===`);

  const res = await axios.get(process.env.FEED_URL, {
    responseType: 'text',
    timeout: 30000,
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const data = parser.parse(res.data);

  let offersArray = null;
  if (data.offers && Array.isArray(data.offers.o)) {
    offersArray = data.offers.o;
  } else if (data.offers && data.offers.o) {
    offersArray = [data.offers.o];
  } else {
    console.log('Nie znalazłem listy offers.o w feedzie Ceneo.');
    return;
  }

  let found = false;

  for (const offer of offersArray) {
    let attrs = offer.attrs?.a;
    if (!attrs) continue;
    if (!Array.isArray(attrs)) attrs = [attrs];

    const eanAttr = attrs.find((a) => a['@_name'] === 'EAN');
    if (!eanAttr || !eanAttr['#text']) continue;

    const ean = String(eanAttr['#text']).trim();
    if (ean !== TEST_EAN) continue;

    const feedQty = toInt(offer['@_stock']);
    const shopQty = feedQty <= 2 ? 0 : feedQty - 2;

    console.log('Znalazłem ofertę w CENEO:');
    console.log(`  @id: ${offer['@_id']}`);
    console.log(`  nazwa: ${offer.name}`);
    console.log(`  @_stock (ilość MJW): ${feedQty}`);
    console.log(
      `  wyliczony stan sklepu (Twoja logika feed-2, min 0): ${shopQty}`
    );

    found = true;
    break;
  }

  if (!found) {
    console.log('W feedzie Ceneo brak oferty z tym EAN.');
  }
}

async function checkInGoogle() {
  console.log(`\n=== SPRAWDZAM W FEEDZIE GOOGLE EAN ${TEST_EAN} ===`);

  const res = await axios.get(process.env.GOOGLE_FEED_URL, {
    responseType: 'text',
    timeout: 30000,
  });

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const data = parser.parse(res.data);

  let items = [];

  if (data.rss && data.rss.channel && Array.isArray(data.rss.channel.item)) {
    items = data.rss.channel.item;
  } else if (data.rss && data.rss.channel && data.rss.channel.item) {
    items = [data.rss.channel.item];
  } else {
    console.log('Nie znalazłem listy item w feedzie Google.');
    return;
  }

  let found = false;

  for (const item of items) {
    const ean = String(item['g:gtin'] || '').trim();
    if (!ean || ean !== TEST_EAN) continue;

    const availability = String(item['g:availability'] || '')
      .trim()
      .toLowerCase();
    const price = String(item['g:price'] || '').trim();

    console.log('Znalazłem ofertę w GOOGLE:');
    console.log(`  title: ${item.title}`);
    console.log(`  link: ${item.link}`);
    console.log(`  availability: ${availability}`);
    console.log(`  price: ${price}`);

    found = true;
    break;
  }

  if (!found) {
    console.log('W feedzie Google brak oferty z tym EAN.');
  }
}

async function main() {
  console.log(`Sprawdzam EAN: ${TEST_EAN}`);
  await checkInPresta();
  await checkInCeneo();
  await checkInGoogle();
  console.log('\n=== KONIEC SPRAWDZANIA EAN ===');
}

main().catch((err) => {
  console.error('Błąd w check-ean:', err.message);
});
