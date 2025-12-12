let CONFIG = null;
let isRunning = false;
let LOGS = [];
let wbTabId = null;

async function loadConfig() {
    const url = chrome.runtime.getURL("config.json");
    const r = await fetch(url);
    return r.json();
}

async function waitConfig() {
    while (!CONFIG) await new Promise(r => setTimeout(r, 20));
}

function preparePrice(txt) {
    if (!txt) return 0;
    return parseInt(txt.replace(/\D+/g, ""), 10) || 0;
}

// ---------------- LOGGING ----------------
async function log(text) {
    if (!CONFIG) { console.log(text); return; }

    if (!CONFIG.scraper.logEnabled) return;

    const line = `[${new Date().toISOString()}] ${text}`;
    console.log(line);
    LOGS.push(line);
    
    if (LOGS.length > 5000) LOGS.shift();

    chrome.storage.local.set({ scraperLogs: LOGS });

    try {
        chrome.runtime.sendMessage({ action: "uiLog", text: line });
    } catch {}
}

async function waitForWBRender(tabId) {
    for (let i = 0; i < 50; i++) { // максимум 5 секунд
        const result = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const priceSelectors = [
                    "[class*='productPrice']"
                ];
                for (const s of priceSelectors) {
                    const el = document.querySelector(s);
                    if (el) return true; // страница загрузила цену
                }
                return false;
            }
        });

        if (result[0].result === true) return true;

        await new Promise(res => setTimeout(res, 100)); // 100 ms delay
    }

    return false;
}

async function waitForSelector(tabId, selector, timeout = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        const [res] = await chrome.scripting.executeScript({
            target: { tabId },
            func: sel => !!document.querySelector(sel),
            args: [selector]
        });

        if (res.result) return true;

        await new Promise(r => setTimeout(r, 80));
    }

    return false;
}

// ---------------- WORKER TAB ----------------

async function getWorkerTab() {
    if (wbTabId) return wbTabId;

    const workerUrl = chrome.runtime.getURL("worker.html");
     
    const tab = await chrome.tabs.create({
        url: workerUrl,
        active: false
    });

    wbTabId = tab.id;
    return tab.id;
}

async function waitTabReady(tabId) {
    return new Promise(resolve => {
        const listener = (id, info) => {
            if (id === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

// --------------------------------------------
//  PARSING PAGE IN REAL TAB
// --------------------------------------------

async function fetchWBPrices(tabId) {
    const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {

            function preparePrice(txt) {
                if (!txt) return 0;
                return parseInt(txt.replace(/\D+/g, ""), 10) || 0;
            }

            const wrap = document.querySelector("[class*='productPrice']");
            
            
            if (!wrap) return { rcPrice: 0, cardPrice: 0, strikePrice: 0 };

            const cardPriceSelectors = [
                    ".mo-typography_color_danger",
                    ".mo-typography_color_accent"
                ];
             
            let el = null;
            for (const s of cardPriceSelectors) {
                el = wrap.querySelector(s);
                if (el) break; 
            }
            
            const rcPriceEl = wrap.querySelector('[class*="priceBlockFinalPrice"]');
            const cardPriceEl = el;
            const strikePriceEl = wrap.querySelector('[class*="priceBlockOldPrice"]');

            return {
                rcPrice: preparePrice(rcPriceEl?.textContent ?? ""),
                cardPrice: preparePrice(cardPriceEl?.textContent ?? ""),
                strikePrice: preparePrice(strikePriceEl?.textContent ?? "")
            };
        }
    });

    return result[0].result;
}

// ---------------- MAIN SCRAPER ----------------

async function fetchPriceViaWB(url) {
    await waitConfig();

    const tabId = await getWorkerTab();

    // Ускоренная версия WB страницы
    url = url + "?targetUrl=XS";

    await chrome.tabs.update(tabId, { url });

    await log("Загружаем страницу товара: "  + url);

    // ждём статуса complete
    await waitTabReady(tabId);

    // Ждём появления блока с ценой
    await waitForSelector(tabId, "[class*='productSummary']");

    const prices = await fetchWBPrices(tabId);

    await log("Цены: " + JSON.stringify(prices));

    return prices;
}

// --------------------------------------------

async function fetchModels() {
    await waitConfig();

    const url = CONFIG.api.baseUrl + CONFIG.api.listEndpoint;
    await log("Получаем список товаров");

    const r = await fetch(url);
    const data = await r.json();

    return Object.values(data).map(v => ({
        sku: v,
        url: `https://www.wildberries.ru/catalog/${v}/detail.aspx`
    }));
    
    /*  return [
  {
    sku: "173461878",
    url: "https://www.wildberries.ru/catalog/173461878/detail.aspx"
  },
]*/
}

async function sendPriceToAPI(sku, prices) {
    const url = CONFIG.api.baseUrl + CONFIG.api.priceEndpoint;
    
    console.log('Отправка цен:', JSON.stringify([{ sku, prices }]));
    
    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ 
                sku, 
                rcPrice: prices.rcPrice,
                cardPrice: prices.cardPrice,
                strikePrice: prices.strikePrice 
            }])
    });
}

// --------------------------------------------

async function runScraper() {
    await waitConfig();

    if (!isRunning) return;

    const models = await fetchModels();
    await log("Товаров: " + models.length);

    for (const m of models) {
        if (!isRunning) break;

        await log("Парсим SKU: " + m.sku);

        const prices = await fetchPriceViaWB(m.url);

        if (prices.rcPrice || prices.cardPrice) {            
            await sendPriceToAPI(m.sku, prices);
        } else {
            await log("Цена не найдена");
        }
    }

    await log("Цикл завершён");
    setTimeout(runScraper, CONFIG.scraper.cycleDelay);
}

// --------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "startScraping") {
        if (!isRunning) {
            isRunning = true;
            runScraper();
        }
    }

    if (msg.action === "stopScraping") {
        isRunning = false;
    }

    if (msg.action === "getLogs") {
        chrome.runtime.sendMessage({ action: "logs", logs: LOGS });
    }
});

// Load config
loadConfig().then(cfg => CONFIG = cfg);