const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SEED_DIR = path.join(ROOT, "data");
const DATA_DIR = process.env.VERCEL ? path.join("/tmp", "mneumnyum") : SEED_DIR;
const bundledSeed = require("./data/2026-10.json");
const PORT = 8765;
const STORES = ["CU", "GS25", "세븐일레븐", "이마트24"];
const QUOTA = { diet: 4, morning: 2, light: 4, hearty: 4 };
const SKIP = /마스크|라이터|쇼핑백|건전지|우산|세제|휴지|샴푸|치약|면도|생리|물티슈|보조배터리|소주|맥주|와인|위스키|막걸리|사케|하이볼|담배|콘돔|반창고|파스|여울|반려동물|강아지|고양이|애견|애묘|펫|대용량|\d+(?:\.\d+)?(?:L|리터|kg|KG)/;
const DIET_RULES = [
    {
        test: (name) => /맥플랜|뉴트리션/.test(name),
        nutrition: "단백질 20g · 제로슈거 · 식이섬유 포뮬러",
        line: "식이섬유 함량 g는 포장 영양성분에서 확인하세요."
    },
    {
        test: (name) => /밸런스밀/.test(name),
        nutrition: "단백질 20g 이상 · 통곡물 식이섬유 · 저당",
        line: ""
    },
    {
        test: (name) => /닭가슴살/.test(name) && /단호박/.test(name),
        nutrition: "단백질은 닭가슴살 · 식이섬유는 단호박과 채소",
        line: "단백질·식이섬유 g는 포장지를 보는 것이 정확합니다."
    },
    {
        test: (name) => /여주/.test(name) && /닭가슴살/.test(name),
        nutrition: "단백질은 닭가슴살·계란 · 식이섬유는 고구마와 채소",
        line: ""
    }
];

function seoulNow(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const pick = (type) => Number(parts.find((part) => part.type === type).value);
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    return {
        year,
        month,
        day,
        monthKey: `${year}-${String(month).padStart(2, "0")}`,
        dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    };
}

function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

function dessertWeekIndex(year, month, day) {
    const first = new Date(year, month - 1, 1);
    const firstWeekday = first.getDay();
    const untilMonday = (8 - firstWeekday) % 7;
    const firstMonday = untilMonday === 0 ? 1 : untilMonday + 1;
    if (day < firstMonday) return 0;
    return 1 + Math.floor((day - firstMonday) / 7);
}

function weekCount(year, month) {
    return dessertWeekIndex(year, month, daysInMonth(year, month)) + 1;
}

function decode(text) {
    return String(text || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

function priceOf(text) {
    const value = Number(String(text || "").replace(/[^\d]/g, ""));
    return Number.isFinite(value) && value > 0 ? value : null;
}

function won(price) {
    return price ? `${String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원` : "";
}

function dietRule(name) {
    return DIET_RULES.find((rule) => rule.test(name)) || null;
}

function isDiet(name) {
    if (dietRule(name)) return true;
    if (/샐러드|샐\)/.test(name)) return true;
    return /프로틴|닭가슴살/.test(name) && /곡물|귀리|현미|고구마|단호박|샐러드|에너지볼/.test(name);
}

function bucketFor(product) {
    if (SKIP.test(product.name)) return null;
    const name = product.name;
    if (isDiet(name)) return "diet";
    const sweet = /모찌|쿠키|케이크|파이|빵|도넛|아이스크림|마카롱|와플|크로플|찹쌀떡|맛탕|푸딩|젤리|양갱|사탕|캔디|껌|웨하스|프레첼|아이스바|캬라멜|캐러멜|카라멜/.test(name)
        || product.category === "과자류"
        || product.category === "아이스크림";
    const drink = (/요거트|주스|라떼|아메리카노|샷|에이드|스무디|식혜|커피|드링크/.test(name) || product.category === "음료")
        && !/우동|김밥|도시락|버거|샌드|덮밥|떡볶/.test(name);
    const meal = /도시락|김밥|버거|면|부리또/.test(name) || (/샌드/.test(name) && !/하겐|아이스크림/.test(name));
    if (sweet && !meal) return "dessert";
    if (drink && !sweet) return "morning";
    if (product.price != null && product.price <= 5000) return "light";
    if (product.price != null && product.price <= 15000) return "hearty";
    return null;
}

async function getText(url, options = {}) {
    const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
            "User-Agent": "Mozilla/5.0",
            Accept: "text/html,application/json",
            ...(options.headers || {})
        },
        body: options.body,
        signal: AbortSignal.timeout(12000)
    });
    return response.text();
}

function parseCu(html, category) {
    return html.split('<li class="prod_list">').slice(1).flatMap((block) => {
        const isNew = block.includes('<span class="new">');
        const isBest = block.includes('<span class="best">');
        if (!isNew && !isBest) return [];
        const name = decode((block.match(/<div class="name"[^>]*>\s*<p>([^<]+)<\/p>/) || [])[1]);
        const price = priceOf((block.match(/<strong>([^<]+)<\/strong>/) || [])[1]);
        if (!name || !price) return [];
        const pick = isNew && isBest ? "best-new" : isBest ? "popular" : "fresh";
        return [{
            id: `CU:${name}`,
            store: "CU",
            name,
            price,
            category,
            best: pick === "best-new",
            pick,
            rank: pick === "best-new" ? 3 : pick === "fresh" ? 2 : 1
        }];
    });
}

async function fetchCu() {
    const categories = [
        ["10", "간편식사"],
        ["20", "즉석조리"],
        ["30", "과자류"],
        ["40", "아이스크림"],
        ["50", "식품"],
        ["60", "음료"]
    ];
    const items = [];
    for (const [code, category] of categories) {
        for (let page = 1; page <= 6; page += 1) {
            const html = await getText(`https://cu.bgfretail.com/product/productAjax.do?gdIdx=0&listType=0&pageIndex=${page}&searchCondition=setA&searchKeyword=&searchMainCategory=${code}&searchSubCategory=&searchUseYn=N`);
            const pageItems = parseCu(html, category);
            items.push(...pageItems);
            if (!html.includes('<li class="prod_list">')) break;
        }
    }
    return items;
}

function parseSevenProducts(html, pick) {
    const matches = [...html.matchAll(/<div class='name'[^>]*>([^<]+)</g)];
    let previous = 0;
    return matches.flatMap((match) => {
        const between = html.slice(previous, match.index);
        previous = match.index;
        const taggedNew = /ico_tag_\d+[^>]*>\s*신상품/.test(between);
        const resolved = pick === "best-list" ? (taggedNew ? "best-new" : "popular") : pick;
        const name = decode(match[1]);
        const after = html.slice(match.index, match.index + 400);
        const price = priceOf((after.match(/<span>([^<]+)<\/span>/) || [])[1]);
        if (!name) return [];
        return [{
            id: `세븐일레븐:${name}`,
            store: "세븐일레븐",
            name,
            price,
            category: "신상품",
            best: resolved === "best-new",
            pick: resolved,
            rank: resolved === "best-new" ? 3 : resolved === "fresh" ? 2 : 1
        }];
    });
}

async function fetchSeven() {
    const bestHtml = await getText("https://www.7-eleven.co.kr/product/bestdosirakList.asp");
    const bestItems = parseSevenProducts(bestHtml, "best-list");
    const seen = new Set(bestItems.map((item) => item.id));
    const fresh = [];
    const first = await getText("https://www.7-eleven.co.kr/product/presentList.asp", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "pTab=8"
    });
    parseSevenProducts(first, "fresh").forEach((item) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        fresh.push(item);
    });
    for (let page = 2; page <= 4; page += 1) {
        const html = await getText("https://www.7-eleven.co.kr/product/listMoreAjax.asp", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `intPageSize=10&intCurrPage=${page}&cateCd1=&cateCd2=&cateCd3=&pTab=8`
        });
        const more = parseSevenProducts(html, "fresh").filter((item) => !seen.has(item.id));
        if (more.length === 0) break;
        more.forEach((item) => {
            seen.add(item.id);
            fresh.push(item);
        });
    }
    return bestItems.concat(fresh);
}

function parseEmart(html) {
    return html.split('<div class="itemWrap">').slice(1).flatMap((block) => {
        if (/<span class="floatL"[^>]*opacity:\s*0;[^>]*>\s*NEW\s*<\/span>/.test(block)) return [];
        if (!/>\s*NEW\s*</.test(block)) return [];
        const name = decode((block.match(/<div class="itemtitle">[\s\S]*?<a[^>]*>([^<]+)<\/a>/) || [])[1]);
        const price = priceOf((block.match(/class="price"[^>]*>([^<]+)</) || [])[1]);
        if (!name) return [];
        return [{
            id: `이마트24:${name}`,
            store: "이마트24",
            name,
            price,
            category: "신상품",
            best: false,
            pick: "fresh",
            rank: 2
        }];
    });
}

async function fetchEmart() {
    const items = [];
    const paths = ["/goods/event", "/goods/pl", "/goods/ff"];
    for (const goodsPath of paths) {
        for (let page = 1; page <= 3; page += 1) {
            const html = await getText(`https://emart24.co.kr${goodsPath}?align=RECENT&page=${page}`);
            items.push(...parseEmart(html));
        }
    }
    return items;
}

async function fetchGs25() {
    const queries = ["도시락", "김밥", "버거", "샌드위치", "덮밥", "치킨", "샐러드", "프로틴", "요거트", "빵", "떡", "모찌", "쿠키", "케이크", "아이스크림", "파이", "커피", "주스", "닭가슴살", "에너지볼"];
    const seen = new Set();
    const items = [];
    async function readPage(query, startCount) {
        const response = await fetch("https://b2c-apigw.woodongs.com/search/v3/totalSearch", {
            method: "POST",
            headers: {
                "User-Agent": "Mozilla/5.0",
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ query, collection: "offlineItem", listCount: 20, startCount }),
            signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error("우리동네GS 신상품 목록을 받지 못했습니다");
        const data = await response.json();
        const collection = (data.SearchQueryResult.Collection || []).find((item) => item.CollectionId === "offlineItem");
        return (collection && collection.Documentset && collection.Documentset.Document) || [];
    }
    for (const query of queries) {
        for (let startCount = 0; startCount < 60; startCount += 20) {
            const docs = await readPage(query, startCount);
            docs.forEach((doc) => {
                const field = doc.field || {};
                const categoryName = `${field.deliveryCategoryName || ""}|${field.pickupCategoryName || ""}`;
                const name = decode(field.itemName);
                const isNew = categoryName.includes("신상품");
                const isRanked = /핫이슈|실시간랭킹/.test(categoryName);
                if (!name || seen.has(field.itemCode) || (!isNew && !isRanked)) return;
                if (field.div !== "GS" && field.prdDiv !== "GS") return;
                seen.add(field.itemCode);
                const lineName = field.lineNm || "";
                let category = lineName;
                if (/아이스크림/.test(lineName)) category = "아이스크림";
                else if (/음료|커피|유제품/.test(lineName)) category = "음료";
                const pick = isNew && isRanked ? "best-new" : isRanked ? "popular" : "fresh";
                const hot = /핫이슈/.test(categoryName) ? 1 : 0;
                items.push({
                    id: `GS25:${field.itemCode}`,
                    store: "GS25",
                    name,
                    price: priceOf(field.sellPrice),
                    category,
                    best: pick === "best-new",
                    pick,
                    rank: (pick === "best-new" ? 30 : pick === "fresh" ? 20 : 10) + hot
                });
            });
            if (docs.length < 20) break;
        }
    }
    return items;
}

async function fetchStore(store, fetcher) {
    try {
        const items = await fetcher();
        const unique = [];
        const seen = new Set();
        items.forEach((item) => {
            if (seen.has(item.id) || !item.pick || !bucketFor(item)) return;
            seen.add(item.id);
            unique.push(item);
        });
        return { store, ok: true, count: unique.length, error: "", items: unique };
    } catch (error) {
        return { store, ok: false, count: 0, error: error.message || "목록을 받지 못했습니다", items: [] };
    }
}

function emptyAssignment(year, month) {
    const days = {};
    for (let day = 1; day <= daysInMonth(year, month); day += 1) {
        days[day] = { diet: [], morning: [], light: [], hearty: [] };
    }
    const dessertWeeks = {};
    for (let week = 0; week < weekCount(year, month); week += 1) dessertWeeks[week] = {};
    return { days, dessertWeeks };
}

function usedIds(assignment) {
    const used = new Set();
    Object.values(assignment.days).forEach((day) => {
        Object.values(day).forEach((ids) => ids.forEach((id) => used.add(id)));
    });
    Object.values(assignment.dessertWeeks).forEach((week) => {
        Object.values(week).forEach((id) => used.add(id));
    });
    return used;
}

function rotated(keys, start) {
    const list = keys.map(Number).sort((a, b) => a - b);
    const index = list.indexOf(start);
    if (index < 0) return list;
    return list.slice(index).concat(list.slice(0, index));
}

function placeSpread(slots, ids, quota, dayOrder) {
    let index = 0;
    dayOrder.forEach((day) => {
        while (slots[day].length < quota && index < ids.length) {
            slots[day].push(ids[index]);
            index += 1;
        }
    });
}

function interleave(ids, catalog) {
    const groups = new Map();
    ids.forEach((id) => {
        const store = catalog.products[id].store;
        if (!groups.has(store)) groups.set(store, []);
        groups.get(store).push(id);
    });
    for (const list of groups.values()) {
        list.sort((a, b) => {
            const left = catalog.products[a];
            const right = catalog.products[b];
            return (right.rank || 0) - (left.rank || 0)
                || Number(Boolean(dietRule(right.name))) - Number(Boolean(dietRule(left.name)));
        });
    }
    const lists = [...groups.values()];
    const mixed = [];
    const longest = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < longest; index += 1) {
        lists.forEach((list) => {
            if (list[index]) mixed.push(list[index]);
        });
    }
    return mixed;
}

function assignProducts(catalog, products, now) {
    const used = usedIds(catalog.assignment);
    const fresh = products.filter((product) => !used.has(product.id) && !catalog.products[product.id]);
    fresh.forEach((product) => {
        catalog.products[product.id] = product;
    });
    const grouped = { diet: [], morning: [], dessert: [], light: [], hearty: [] };
    fresh.forEach((product) => {
        const bucket = bucketFor(product);
        if (bucket) grouped[bucket].push(product.id);
    });
    grouped.diet = interleave(grouped.diet, catalog);
    grouped.morning = interleave(grouped.morning, catalog);
    grouped.light = interleave(grouped.light, catalog);
    grouped.hearty = interleave(grouped.hearty, catalog);
    const dayOrder = rotated(Object.keys(catalog.assignment.days), now.day);
    ["diet", "morning"].forEach((bucket) => {
        const slots = {};
        dayOrder.forEach((day) => {
            slots[day] = catalog.assignment.days[day][bucket];
        });
        placeSpread(slots, grouped[bucket], QUOTA[bucket], dayOrder);
    });
    const dessertLeft = grouped.dessert.filter((id) => !usedIds(catalog.assignment).has(id));
    const byStore = {};
    STORES.forEach((store) => {
        byStore[store] = dessertLeft
            .filter((id) => catalog.products[id].store === store)
            .sort((a, b) => (catalog.products[b].rank || 0) - (catalog.products[a].rank || 0));
    });
    const weeks = rotated(Object.keys(catalog.assignment.dessertWeeks), dessertWeekIndex(now.year, now.month, now.day));
    STORES.forEach((store) => {
        const list = byStore[store];
        list.forEach((id) => {
            const week = weeks.find((item) => !catalog.assignment.dessertWeeks[item][store]);
            if (week == null) return;
            catalog.assignment.dessertWeeks[week][store] = id;
        });
        const fallback = list[0];
        if (!fallback) return;
        weeks.forEach((week) => {
            if (!catalog.assignment.dessertWeeks[week][store]) {
                catalog.assignment.dessertWeeks[week][store] = fallback;
            }
        });
    });
    const taken = usedIds(catalog.assignment);
    ["light", "hearty"].forEach((bucket) => {
        const slots = {};
        dayOrder.forEach((day) => {
            slots[day] = catalog.assignment.days[day][bucket];
        });
        placeSpread(slots, grouped[bucket].filter((id) => !taken.has(id)), QUOTA[bucket], dayOrder);
    });
}

function catalogPath(monthKey) {
    return path.join(DATA_DIR, `${monthKey}.json`);
}

function readCatalog(monthKey) {
    const file = catalogPath(monthKey);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    if (bundledSeed && bundledSeed.monthKey === monthKey) return bundledSeed;
    const seedFile = path.join(SEED_DIR, `${monthKey}.json`);
    if (seedFile !== file && fs.existsSync(seedFile)) return JSON.parse(fs.readFileSync(seedFile, "utf8"));
    return null;
}

function writeCatalog(catalog) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(catalogPath(catalog.monthKey), JSON.stringify(catalog));
    } catch (error) {
        console.error(error);
    }
}

async function buildCatalog(now) {
    const previous = readCatalog(now.monthKey);
    const keep = previous && previous.rule === "schedule-2" && previous.monthKey === now.monthKey;
    const results = await Promise.all([
        fetchStore("CU", fetchCu),
        fetchStore("GS25", fetchGs25),
        fetchStore("세븐일레븐", fetchSeven),
        fetchStore("이마트24", fetchEmart)
    ]);
    const catalog = keep ? previous : {
        monthKey: now.monthKey,
        year: now.year,
        month: now.month,
        rule: "schedule-2",
        products: {},
        assignment: emptyAssignment(now.year, now.month),
        sources: []
    };
    assignProducts(catalog, results.flatMap((result) => result.items), now);
    catalog.fetchedOn = now.dateKey;
    catalog.rule = "schedule-2";
    catalog.sources = results.map(({ store, ok, count, error }) => ({ store, ok, count, error }));
    writeCatalog(catalog);
    return catalog;
}

let pending = null;

async function ensureCatalog() {
    const now = seoulNow();
    const cached = readCatalog(now.monthKey);
    if (cached && cached.fetchedOn === now.dateKey && cached.rule === "schedule-2") return cached;
    if (!pending) {
        pending = buildCatalog(now).finally(() => {
            pending = null;
        });
    }
    return pending;
}

function roleLabel(index, total) {
    const dinnerCount = Math.ceil(total / 2);
    if (index < dinnerCount) return `🍽️ [저녁 ${index + 1}]`;
    return `🌙 [야식 ${index - dinnerCount + 1}]`;
}

function toCard(product, title, tone) {
    const rule = dietRule(product.name);
    const price = won(product.price);
    return {
        title: price ? `${title} ${product.name} (${price})` : `${title} ${product.name}`,
        compose: `${product.name} 1개`,
        nutrition: rule ? rule.nutrition : "",
        tip: product.pick === "popular"
            ? "신상이 없어서 베스트 상품으로 골랐습니다."
            : product.pick === "fresh"
                ? "공식 신상품입니다. 점포마다 없을 수 있습니다."
                : "공식 베스트 신상품입니다. 점포마다 없을 수 있습니다.",
        where: product.store,
        line: [
            rule && rule.line,
            isDiet(product.name) && !rule ? "단백질·식이섬유 g는 포장 영양성분에서 확인하세요." : "",
            product.pick === "best-new" ? "공식 신상품 랭킹에 있습니다." : ""
        ].filter(Boolean).join(" "),
        tone
    };
}

function bestStandins(catalog, bucket, count) {
    const weight = (product) => product.pick === "best-new" ? 3 : product.pick === "popular" ? 2 : 1;
    return Object.values(catalog.products)
        .filter((product) => bucketFor(product) === bucket)
        .sort((left, right) => weight(right) - weight(left) || (right.rank || 0) - (left.rank || 0))
        .slice(0, count)
        .map((product) => product.id);
}

function cardsFor(catalog, now) {
    const day = catalog.assignment.days[now.day] || { diet: [], morning: [], light: [], hearty: [] };
    const tone = () => "sky";
    const dietTitles = ["1️⃣ 아침:", "2️⃣ 한 끼:", "3️⃣ 가벼운 저녁:", "4️⃣ 야식 대신:"];
    const mapIds = (ids, titleOf) => ids.map((id, index) => toCard(catalog.products[id], titleOf(index, ids.length), tone(index)));
    const section = (ids, bucket) => ids.length ? ids : bestStandins(catalog, bucket, QUOTA[bucket]);
    const week = catalog.assignment.dessertWeeks[dessertWeekIndex(now.year, now.month, now.day)] || {};
    const marks = { CU: "🟢", GS25: "🔵", 세븐일레븐: "🟠", 이마트24: "🟡" };
    const usedDesserts = new Set(Object.values(week).filter(Boolean));
    return {
        monthLabel: `${now.month}월`,
        dateLabel: `${now.month}월 ${now.day}일`,
        fetchedOn: catalog.fetchedOn,
        sources: catalog.sources,
        diet: mapIds(section(day.diet, "diet"), (index) => dietTitles[index] || `${index + 1}.`),
        morning: mapIds(section(day.morning, "morning"), (index) => `${index + 1}️⃣`),
        light: mapIds(section(day.light, "light"), roleLabel),
        hearty: mapIds(section(day.hearty, "hearty"), roleLabel),
        dessert: STORES.flatMap((store, index) => {
            let product = week[store] ? catalog.products[week[store]] : null;
            if (!product) {
                product = Object.values(catalog.products)
                    .filter((item) => item.store === store && bucketFor(item) === "dessert" && !usedDesserts.has(item.id))
                    .sort((left, right) => (right.rank || 0) - (left.rank || 0))[0] || null;
            }
            if (!product) return [];
            usedDesserts.add(product.id);
            return [toCard(product, `${marks[store]} [${store}]`, tone(index))];
        })
    };
}

function send(res, status, body, type) {
    res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store"
    });
    res.end(body);
}

async function todayPayload() {
    const catalog = await ensureCatalog();
    return cardsFor(catalog, seoulNow());
}

if (require.main === module) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
        if (url.pathname === "/api/today") {
            try {
                send(res, 200, JSON.stringify(await todayPayload()), "application/json; charset=utf-8");
            } catch (error) {
                send(res, 500, JSON.stringify({ error: error.message || "목록을 받지 못했습니다" }), "application/json; charset=utf-8");
            }
            return;
        }
        const requested = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
        const extension = path.extname(requested);
        const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
        if (requested.startsWith(ROOT) && types[extension] && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
            send(res, 200, fs.readFileSync(requested), types[extension]);
            return;
        }
        send(res, 200, fs.readFileSync(path.join(ROOT, "index.html")), "text/html; charset=utf-8");
    });
    server.listen(PORT, () => {
        console.log(`Serving HTTP on ${PORT}`);
    });
}

module.exports = { todayPayload };
