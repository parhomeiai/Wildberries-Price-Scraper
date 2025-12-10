let CONFIG = null;
let isRunning = false;
let LOGS = [];

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

    chrome.storage.local.set({ scraperLogs: LOGS });

    try {
        chrome.runtime.sendMessage({ action: "uiLog", text: line });
    } catch {}
}

async function getTabHTML(tabId) {
    // Ждем пока React WB дорисует страницу
    const ready = await waitForWBRender(tabId);

    if (!ready) {
        console.log("WB render timeout — контент не загрузился");
    }

    // Забираем DOM
    const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.documentElement.outerHTML
    });

    return result[0].result;
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

async function fetchPriceUsingTab(url) {
    await waitConfig();
    await log("Открываем вкладку: " + url);

    // 1. Создаём закрытую вкладку
    const tab = await chrome.tabs.create({
        url,
        active: false
    });

    // 2. Ждём загрузку страницы
    await new Promise(resolve => {
        const listener = (tabId, changeInfo) => {
            if (tabId === tab.id && changeInfo.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });

    await log("Страница загружена. Запускаем парсер во вкладке");
    
    // Ждём загрузку цены React-ом
    await waitForWBRender(tab.id);
    
    const prices = await fetchWBPrices(tab.id);

    await log("Цена: " + JSON.stringify(prices));

    // 4. Закрываем вкладку
    chrome.tabs.remove(tab.id);

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
    
      /*return [
  {
    modelId: "173461878",
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

        const prices = await fetchPriceUsingTab(m.url);

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