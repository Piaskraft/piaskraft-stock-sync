// index.js
require('dotenv').config();
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

if (!process.env.PRESTA_URL || !process.env.PRESTA_API_KEY) {
  console.error('Brak PRESTA_URL lub PRESTA_API_KEY w pliku .env');
  process.exit(1);
}

const APPLY_CHANGES = process.env.APPLY_CHANGES === 'true';
const MAX_UPDATES = parseInt(process.env.MAX_UPDATES || '10', 10);
const GOOGLE_FALLBACK_QTY = parseInt(process.env.GOOGLE_FALLBACK_QTY || '2', 10);

const ALLOWED_EANS = (process.env.ALLOWED_EANS || '')
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

// klient do Presty (JSON – do list produktów i stanów)
const presta = axios.create({
  baseURL: `${process.env.PRESTA_URL}/api`,
  auth: {
    username: process.env.PRESTA_API_KEY,
    password: '',
  },
  params: {
    output_format: 'JSON',
  },
  timeout: 15000,
});

// klient do Presty (XML – do PUT)
const prestaXml = axios.create({
  baseURL: `${process.env.PRESTA_URL}/api`,
  auth: {
    username: process.env.PRESTA_API_KEY,
    password: '',
  },
  timeout: 15000,
});

function toInt(value) {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

// ===== PRESTA: produkty + stock_availables =====

async function fetchAllProductsWithEan() {
  const PAGE_SIZE = 100;
  let start = 0;
  const all = [];

  while (true) {
    const res = await presta.get('/products', {
      params: {
        display: '[id,ean13]',
        limit: `${start},${PAGE_SIZE}`,
      },
    });

    const batch = res.data.products || [];
    if (!batch.length) break;

    all.push(...batch);

    if (batch.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  const productsByEan = {};
  const productsWithoutEan = [];
  const duplicatedEans = new Set();

  for (const p of all) {
    const ean = (p.ean13 || '').trim();

    if (!ean) {
      productsWithoutEan.push(p.id);
      continue;
    }

    if (productsByEan[ean]) {
      duplicatedEans.add(ean);
    }

    productsByEan[ean] = {
      id_product: p.id,
    };
  }

  return { productsByEan, productsWithoutEan, duplicatedEans };
}

async function fetchAllStockAvailables() {
  const PAGE_SIZE = 100;
  let start = 0;
  const all = [];

  while (true) {
    const res = await presta.get('/stock_availables', {
      params: {
        display: '[id,id_product,quantity]',
        limit: `${start},${PAGE_SIZE}`,
      },
    });

    const batch = res.data.stock_availables || [];
    if (!batch.length) break;

    all.push(...batch);

    if (batch.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  const stockByProductId = {};

  for (const s of all) {
    stockByProductId[s.id_product] = {
      id_stock_available: s.id,
      quantity: toInt(s.quantity),
    };
  }

  return stockByProductId;
}

// ===== FEED CENEO: EAN -> { feedQty, shopQty } =====

async function buildFeedStockByEan() {
  if (!process.env.FEED_URL) {
    throw new Error('Brak FEED_URL w .env');
  }

  console.log('Pobieram feed CENEO z:', process.env.FEED_URL);

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
    throw new Error('Nie udało się znaleźć listy ofert w feedzie (offers.o)');
  }

  const feedByEan = {};
  const duplicatedEans = new Set();

  for (const offer of offersArray) {
    let attrs = offer.attrs?.a;
    if (!attrs) continue;
    if (!Array.isArray(attrs)) attrs = [attrs];

    const eanAttr = attrs.find((a) => a['@_name'] === 'EAN');
    if (!eanAttr || !eanAttr['#text']) continue;

    const ean = String(eanAttr['#text']).trim();
    if (!ean) continue;

    const feedQty = toInt(offer['@_stock']);
    const shopQty = feedQty <= 2 ? 0 : feedQty - 2;

    if (feedByEan[ean]) duplicatedEans.add(ean);

    feedByEan[ean] = { feedQty, shopQty };
  }

  return {
    feedByEan,
    duplicatedEans,
    totalOffers: offersArray.length,
  };
}

// ===== FEED GOOGLE: EAN -> { availability } =====

async function buildGoogleByEan() {
  if (!process.env.GOOGLE_FEED_URL) {
    console.log('Brak GOOGLE_FEED_URL w .env – pomijam feed Google.');
    return {
      googleByEan: {},
      totalGoogleItems: 0,
    };
  }

  console.log('Pobieram feed GOOGLE z:', process.env.GOOGLE_FEED_URL);

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
    console.log('Nie udało się znaleźć listy item w feedzie Google.');
    return {
      googleByEan: {},
      totalGoogleItems: 0,
    };
  }

  const googleByEan = {};

  for (const item of items) {
    const ean = String(item['g:gtin'] || '').trim();
    if (!ean) continue;

    const availability = String(item['g:availability'] || '')
      .trim()
      .toLowerCase();
    googleByEan[ean] = { availability };
  }

  return {
    googleByEan,
    totalGoogleItems: items.length,
  };
}

// ===== AKTUALIZACJA XML W PREŚCIE =====

function updateQuantityInXml(xml, newQty) {
  // najpierw wersja z CDATA
  let updated = xml.replace(
    /<quantity><!\[CDATA\[(.*?)\]\]><\/quantity>/,
    `<quantity><![CDATA[${newQty}]]></quantity>`
  );

  if (updated === xml) {
    // wersja bez CDATA
    updated = xml.replace(
      /<quantity>(.*?)<\/quantity>/,
      `<quantity>${newQty}</quantity>`
    );
  }

  return updated;
}

async function applyChanges(toChange, stockByProductId) {
  if (!APPLY_CHANGES) {
    console.log(
      '\nAPPLY_CHANGES=false -> tryb DRY-RUN, NIE wysyłam zmian do Presty.'
    );
    return;
  }

  console.log(
    `\nAPPLY_CHANGES=true -> wysyłam zmiany do Presty (max ${MAX_UPDATES} szt.).`
  );

  const slice = toChange.slice(0, MAX_UPDATES);

  for (const change of slice) {
    const stockInfo = stockByProductId[change.id_product];
    if (!stockInfo) {
      console.log(
        `POMIJAM: brak stock_availables dla produktu ${change.id_product} (EAN ${change.ean})`
      );
      continue;
    }

    const idStock = stockInfo.id_stock_available;

    try {
      // pobierz aktualny XML
      const res = await prestaXml.get(`/stock_availables/${idStock}`, {
        responseType: 'text',
      });

      const currentXml = res.data;
      const newXml = updateQuantityInXml(currentXml, change.targetQty);

      if (currentXml === newXml) {
        console.log(
          `POMIJAM: nie udało się podmienić <quantity> w XML dla stock ${idStock}`
        );
        continue;
      }

      await prestaXml.put(`/stock_availables/${idStock}`, newXml, {
        headers: { 'Content-Type': 'text/xml' },
      });

      console.log(
        `OK: produkt ${change.id_product} (EAN ${change.ean}) qty ${change.currentQty} -> ${change.targetQty}`
      );
    } catch (err) {
      const status = err.response?.status;
      console.error(
        `BŁĄD przy aktualizacji stock ${idStock} (product ${change.id_product}):`,
        status || '',
        err.message
      );
    }
  }

  if (toChange.length > MAX_UPDATES) {
    console.log(
      `\nUWAGA: było ${toChange.length} potencjalnych zmian, zastosowano tylko pierwsze ${MAX_UPDATES}.`
    );
  }
}

// ===== MAIN =====

async function main() {
  console.log('--- SYNC STANÓW – DRY-RUN + (ewentualnie) APPLY ---');

  console.log('Pobieram produkty z EAN...');
  const {
    productsByEan,
    productsWithoutEan,
    duplicatedEans: duplicatedEansInPresta,
  } = await fetchAllProductsWithEan();
  console.log('Liczba produktów z EAN:', Object.keys(productsByEan).length);
  console.log('Produkty bez EAN:', productsWithoutEan.length);
  if (duplicatedEansInPresta.size > 0) {
    console.log(
      'Duplikaty EAN w Preście (liczba różnych EAN):',
      duplicatedEansInPresta.size
    );
  }

  console.log('Pobieram stock_availables...');
  const stockByProductId = await fetchAllStockAvailables();
  console.log(
    'Liczba rekordów stock_availables:',
    Object.keys(stockByProductId).length
  );

  console.log('Buduję mapę EAN z feedu CENEO...');
  const {
    feedByEan,
    duplicatedEans: duplicatedEansInFeed,
    totalOffers,
  } = await buildFeedStockByEan();
  console.log('Liczba ofert w feedzie (offers.o):', totalOffers);
  console.log(
    'Liczba różnych EAN w feedzie (CENEO):',
    Object.keys(feedByEan).length
  );
  if (duplicatedEansInFeed.size > 0) {
    console.log(
      'Duplikaty EAN w feedzie CENEO (liczba różnych EAN):',
      duplicatedEansInFeed.size
    );
  }

  console.log('Buduję mapę EAN z feedu GOOGLE...');
  const { googleByEan, totalGoogleItems } = await buildGoogleByEan();
  console.log('Liczba pozycji w feedzie Google:', totalGoogleItems);
  console.log(
    'Liczba różnych EAN w feedzie Google:',
    Object.keys(googleByEan).length
  );

  const toChange = [];
  const productsNotInCeneo = [];
  const feedWithoutProduct = [];
  const productsFromGoogle = [];
  const productsNoSource = [];

  let usedCeneo = 0;
  let usedGoogle = 0;
  let usedNone = 0;

  // 1) każdy produkt z Presty
  for (const [ean, { id_product }] of Object.entries(productsByEan)) {
    const stock = stockByProductId[id_product];
    const currentQty = stock ? stock.quantity : null;

    const ceneoEntry = feedByEan[ean];
    const googleEntry = googleByEan[ean];

    let targetQty;
    let source;

    if (ceneoEntry) {
      targetQty = ceneoEntry.shopQty;
      source = 'ceneo';
      usedCeneo += 1;
    } else if (googleEntry) {
      const availability = googleEntry.availability;
      if (availability === 'in_stock') {
        targetQty = GOOGLE_FALLBACK_QTY;
      } else {
        targetQty = 0;
      }
      source = 'google';
      usedGoogle += 1;
    } else {
      targetQty = 0;
      source = 'none';
      usedNone += 1;
    }

    if (!ceneoEntry) {
      productsNotInCeneo.push({ ean, id_product, currentQty, targetQty, source });
    }

    if (source === 'google') {
      productsFromGoogle.push({ ean, id_product, currentQty, targetQty });
    }

    if (source === 'none') {
      productsNoSource.push({ ean, id_product, currentQty, targetQty });
    }

    if (currentQty === null) continue;

    if (currentQty !== targetQty) {
      toChange.push({
        ean,
        id_product,
        currentQty,
        targetQty,
        source,
      });
    }
  }

  // 2) oferty z feedu CENEO bez produktu w Preście
  for (const ean of Object.keys(feedByEan)) {
    if (!productsByEan[ean]) {
      const { feedQty, shopQty } = feedByEan[ean];
      feedWithoutProduct.push({ ean, feedQty, shopQty });
    }
  }

  console.log('--- PODSUMOWANIE ---');
  console.log('Produkty w Preście, które zmieniłyby stan:', toChange.length);
  console.log(
    'Produkty z Presty BEZ wpisu w CENEO (źródło google/none):',
    productsNotInCeneo.length
  );
  console.log(
    'Oferty z feedu CENEO bez produktu w Preście:',
    feedWithoutProduct.length
  );
  console.log('Produkty korzystające z CENEO:', usedCeneo);
  console.log('Produkty korzystające z GOOGLE:', usedGoogle);
  console.log('Produkty bez żadnego źródła (ustawialibyśmy 0):', usedNone);

  console.log('\nPrzykładowe zmiany (max 10):');
  toChange.slice(0, 10).forEach((c) => {
    console.log(
      `EAN ${c.ean} | produkt ${c.id_product} | obecnie = ${c.currentQty} -> docelowo = ${c.targetQty} | źródło=${c.source}`
    );
  });

  console.log('\nPrzykładowe produkty z Presty, których nie ma w CENEO (max 5):');
  productsNotInCeneo.slice(0, 5).forEach((p) => {
    console.log(
      `EAN ${p.ean} | produkt ${p.id_product} | obecnie = ${p.currentQty} -> docelowo = ${p.targetQty} | źródło=${p.source}`
    );
  });

  console.log('\nPrzykładowe produkty z Presty zasilane z GOOGLE (max 5):');
  productsFromGoogle.slice(0, 5).forEach((p) => {
    console.log(
      `EAN ${p.ean} | produkt ${p.id_product} | obecnie = ${p.currentQty} -> docelowo = ${p.targetQty}`
    );
  });

  console.log('\nPrzykładowe produkty z Presty bez żadnego źródła (max 5):');
  productsNoSource.slice(0, 5).forEach((p) => {
    console.log(
      `EAN ${p.ean} | produkt ${p.id_product} | obecnie = ${p.currentQty} -> docelowo = ${p.targetQty}`
    );
  });

  console.log(
    '\nPrzykładowe oferty z feedu CENEO bez produktu w Preście (max 5):'
  );
  feedWithoutProduct.slice(0, 5).forEach((f) => {
    console.log(
      `EAN ${f.ean} | feedQty = ${f.feedQty} | wyliczony stan sklepu = ${f.shopQty}`
    );
  });

  // TU wchodzą realne zmiany, jeśli APPLY_CHANGES=true
  let finalToChange = toChange;

  if (ALLOWED_EANS.length > 0) {
    finalToChange = toChange.filter((c) => ALLOWED_EANS.includes(c.ean));
    console.log(
      `\nFILTR EAN: ALLOWED_EANS=${ALLOWED_EANS.join(
        ', '
      )} -> do aktualizacji trafi ${finalToChange.length} pozycji.`
    );
  }

  await applyChanges(finalToChange, stockByProductId);

  console.log('\n--- KONIEC SKRYPTU ---');
}

main().catch((err) => {
  console.error('Błąd w main:', err.message);
});
