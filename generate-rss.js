const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");

const baseURL = "https://samakal.com";
const targetURL = "https://samakal.com/latest/news";
const flareSolverrURL = process.env.FLARESOLVERR_URL || "http://localhost:8191";
const FEED_PATH = "./feeds/feed.xml";
const MAX_ITEMS = 500;

fs.mkdirSync("./feeds", { recursive: true });

// ===== BENGALI DATE PARSING =====
const BENGALI_DIGITS = {
  '০':'0','১':'1','২':'2','৩':'3','৪':'4',
  '৫':'5','৬':'6','৭':'7','৮':'8','৯':'9',
};
const BENGALI_MONTHS = {
  'জানুয়ারি':'January','ফেব্রুয়ারি':'February','মার্চ':'March',
  'এপ্রিল':'April','মে':'May','জুন':'June','জুলাই':'July',
  'আগস্ট':'August','সেপ্টেম্বর':'September','অক্টোবর':'October',
  'নভেম্বর':'November','ডিসেম্বর':'December',
};

function bengaliToAscii(str) {
  return str.replace(/[০-৯]/g, d => BENGALI_DIGITS[d] || d);
}

// Parses "প্রকাশিতঃ ০৪ এপ্রিল ২০২৬ | ০৯:৩৪"
function parseSamakalDate(raw) {
  if (!raw || !raw.trim()) return new Date();

  const cleaned = raw.replace(/প্রকাশিতঃ\s*/g, "").trim();
  const [datePart, timePart] = cleaned.split("|").map(s => s.trim());

  if (!datePart) return new Date();

  let dateEn = bengaliToAscii(datePart); // "04 এপ্রিল 2026"
  const timeEn = timePart ? bengaliToAscii(timePart) : "00:00";

  for (const [bn, en] of Object.entries(BENGALI_MONTHS)) {
    if (dateEn.includes(bn)) {
      dateEn = dateEn.replace(bn, en);
      break;
    }
  }

  const d = new Date(`${dateEn} ${timeEn}`);
  if (!isNaN(d.getTime())) return d;

  console.warn(`⚠️  Could not parse date: "${raw}" — using now()`);
  return new Date();
}

function parseItemDate(raw) {
  if (!raw || !raw.trim()) return new Date();
  const trimmed = raw.trim();

  // Relative English fallback: "2 hours ago" etc.
  const relMatch = trimmed.match(/^(\d+)\s+(minute|hour|day)s?\s+ago$/i);
  if (relMatch) {
    const n    = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const ms   = unit === "minute" ? n * 60_000
               : unit === "hour"   ? n * 3_600_000
               :                     n * 86_400_000;
    return new Date(Date.now() - ms);
  }

  // Bengali date format used by Samakal
  if (/[০-৯]/.test(trimmed) || /প্রকাশিতঃ/.test(trimmed)) {
    return parseSamakalDate(trimmed);
  }

  // Plain ISO / RFC fallback
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d;

  console.warn(`⚠️  Could not parse date: "${trimmed}" — using now()`);
  return new Date();
}

// ===== LOAD EXISTING ITEMS FROM FEED =====
function loadExistingItems() {
  if (!fs.existsSync(FEED_PATH)) return [];

  try {
    const xml = fs.readFileSync(FEED_PATH, "utf-8");
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];

    $("item").each((_, el) => {
      const $el    = $(el);
      const title  = $el.find("title").first().text().trim();
      const link   = $el.find("link").first().text().trim()
                  || $el.find("guid").first().text().trim();
      const desc   = $el.find("description").first().text().trim();
      const author = $el.find("author").first().text().trim()
                  || $el.find("dc\\:creator").first().text().trim();
      const pubDate = $el.find("pubDate").first().text().trim();

      if (!title || !link) return;
      items.push({ title, link, description: desc, author, date: parseItemDate(pubDate) });
    });

    console.log(`📂 Loaded ${items.length} existing items from feed`);
    return items;
  } catch (err) {
    console.warn(`⚠️  Could not parse existing feed: ${err.message} — starting fresh`);
    return [];
  }
}

// ===== FLARESOLVERR =====
async function fetchWithFlareSolverr(url) {
  console.log(`Fetching ${url} via FlareSolverr...`);
  const response = await axios.post(
    `${flareSolverrURL}/v1`,
    { cmd: "request.get", url, maxTimeout: 60000 },
    { headers: { "Content-Type": "application/json" }, timeout: 65000 }
  );
  if (response.data?.solution) {
    console.log("✅ FlareSolverr successfully bypassed protection");
    return response.data.solution.response;
  }
  throw new Error("FlareSolverr did not return a solution");
}

// ===== MAIN =====
async function generateRSS() {
  try {
    const htmlContent = await fetchWithFlareSolverr(targetURL);
    const $ = cheerio.load(htmlContent);
    const newItems = [];
    const seen = new Set();

    // Each article lives in div.CatListNews > a
    $("div.CatListNews").each((_, el) => {
      const $card = $(el);
      const $a    = $card.find("a").first();
      const href  = $a.attr("href");
      if (!href) return;

      const link = href.startsWith("http") ? href : baseURL + href;
      if (seen.has(link)) return;
      seen.add(link);

      // Title: full h3 text, stripping the optional subHeading span
      const $h3   = $card.find("h3").first();
      $h3.find("span.subHeading").remove();
      const title = $h3.text().trim();
      if (!title) return;

      // Description
      const desc = $card.find("div.ListDesc p").first().text().trim();

      // Category (used as author / section label)
      const category = $card.find("div.CatNameSP").first().text().trim();

      // Date: "প্রকাশিতঃ ০৪ এপ্রিল ২০২৬ | ০৯:৩৪"
      const rawDate = $card.find("span.publishTime").first().text().trim();

      newItems.push({
        title,
        link,
        description: desc,
        author: category,
        date: parseItemDate(rawDate),
      });
    });

    console.log(`🆕 Scraped ${newItems.length} articles from page`);

    // ===== MERGE: new items take priority; deduplicate by link =====
    const existingItems  = loadExistingItems();
    const existingByLink = new Map(existingItems.map(i => [i.link, i]));

    for (const item of newItems) {
      existingByLink.set(item.link, item);
    }

    const merged = [...existingByLink.values()]
      .sort((a, b) => b.date - a.date)
      .slice(0, MAX_ITEMS);

    console.log(`📦 Total items after merge: ${merged.length}`);

    if (merged.length === 0) {
      merged.push({
        title:       "No articles found yet",
        link:        baseURL,
        description: "RSS feed could not scrape any articles.",
        author:      "",
        date:        new Date(),
      });
    }

    const feed = new RSS({
      title:       "সমকাল - সর্বশেষ",
      description: "Latest news from Samakal",
      feed_url:    targetURL,
      site_url:    baseURL,
      language:    "bn",
      pubDate:     new Date().toUTCString(),
    });

    merged.forEach(item => {
      feed.item({
        title:       item.title,
        url:         item.link,
        description: item.description,
        author:      item.author || undefined,
        date:        item.date,
      });
    });

    const xml = feed.xml({ indent: true });
    fs.writeFileSync(FEED_PATH, xml);
    console.log(`✅ RSS written with ${merged.length} items (max ${MAX_ITEMS}).`);

  } catch (err) {
    console.error("❌ Error generating RSS:", err.message);

    if (fs.existsSync(FEED_PATH)) {
      console.log("⚠️  Scrape failed — existing feed preserved as-is.");
      return;
    }

    const feed = new RSS({
      title:       "সমকাল (error fallback)",
      description: "RSS feed could not scrape, showing placeholder",
      feed_url:    targetURL,
      site_url:    baseURL,
      language:    "bn",
      pubDate:     new Date().toUTCString(),
    });
    feed.item({
      title:       "Feed generation failed",
      url:         baseURL,
      description: "An error occurred during scraping.",
      date:        new Date(),
    });
    fs.writeFileSync(FEED_PATH, feed.xml({ indent: true }));
  }
}

generateRSS();
