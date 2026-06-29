let CONFIG = null;
let LOGS = [];
let wbTabId = null;
let isProcessing = false;

const STATE_KEY = "scraperState";
const LOGS_KEY = "scraperLogs";
const ALARM_NAME = "wb_scraper_alarm";

const DEFAULT_STATE = {
    enabled: false,
    lastRunAt: 0,
    lastSuccessAt: 0,
    lastError: null
};

async function getState() {
    const data = await chrome.storage.local.get(STATE_KEY);
    return { ...DEFAULT_STATE, ...(data[STATE_KEY] || {}) };
}

async function setState(patch) {
    const current = await getState();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
}

async function loadConfig() {
    if (CONFIG) return CONFIG;

    const url = chrome.runtime.getURL("config.json");
    const r = await fetch(url);
    CONFIG = await r.json();
    return CONFIG;
}

async function waitConfig() {
    if (!CONFIG) {
        await loadConfig();
    }
}

function preparePrice(txt) {
    if (!txt) return 0;
    return parseInt(txt.replace(/\D+/g, ""), 10) || 0;
}

// ---------------- LOGGING ----------------
async function log(text) {
    await waitConfig().catch(() => {});

    const line = `[${new Date().toISOString()}] ${text}`;
    console.log(line);

    if (CONFIG?.scraper?.logEnabled === false) return;

    LOGS.push(line);
    if (LOGS.length > 5000) LOGS.shift();

    await chrome.storage.local.set({ [LOGS_KEY]: LOGS });

    try {
        chrome.runtime.sendMessage({ action: "uiLog", text: line });
    } catch {}
}

async function loadLogsFromStorage() {
    const data = await chrome.storage.local.get(LOGS_KEY);
    LOGS = data[LOGS_KEY] || [];
}

// ---------------- HELPERS ----------------

async function safeFetch(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response;
}

async function ensureAlarm() {
    await chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: 1
    });
}

async function clearWorkerTab() {
    if (!wbTabId) return;

    try {
        await chrome.tabs.get(wbTabId);
    } catch {
        wbTabId = null;
    }
}

async function isNetworkAvailable() {
    await waitConfig();

    try {
        const testUrl = CONFIG.api.testUrl;
        const r = await fetch(testUrl, {
            method: "HEAD",
            cache: "no-store"
        });
        return r.ok;
    } catch {
        return false;
    }
}

// ---------------- TAB / PAGE ----------------

async function waitForWBRender(tabId) {
    for (let i = 0; i < 50; i++) { // максимум 5 секунд
        try {
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
        } catch {}

        await new Promise(res => setTimeout(res, 100)); // 100 ms delay
    }

    return false;
}

async function waitForSelector(tabId, selector, timeout = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        try {
            const [res] = await chrome.scripting.executeScript({
                target: { tabId },
                func: sel => !!document.querySelector(sel),
                args: [selector]
            });

            if (res.result) return true;
        } catch {}

        await new Promise(r => setTimeout(r, 80));
    }

    return false;
}

// ---------------- WORKER TAB ----------------

async function getWorkerTab() {
    await clearWorkerTab();
    
    if (wbTabId) return wbTabId;

    const workerUrl = chrome.runtime.getURL("worker.html");
     
    const tab = await chrome.tabs.create({
        url: workerUrl,
        active: false
    });

    wbTabId = tab.id;
    return tab.id;
}

async function waitTabReady(tabId, timeout = 15000) {
    return new Promise((resolve, reject) => {
        let done = false;

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error("Таймаут загрузки вкладки"));
        }, timeout);

        const listener = (id, info) => {
            if (id === tabId && info.status === "complete") {
                if (done) return;
                done = true;
                clearTimeout(timer);
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

// ---------------- API ----------------

async function fetchModels() {
    await waitConfig();

    const url = CONFIG.api.baseUrl + CONFIG.api.listEndpoint;
    await log("Получаем список товаров");

    const r = await safeFetch(url);
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
    await waitConfig();

    const url = CONFIG.api.baseUrl + CONFIG.api.priceEndpoint;

    await log(`Отправка цен для SKU ${sku}: ${JSON.stringify(prices)}`);

    await safeFetch(url, {
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

// ---------------- MAIN SCRAPER ----------------

async function fetchPriceViaWB(url) {
    await waitConfig();

    const tabId = await getWorkerTab();
    const finalUrl = url.includes("?") ? `${url}&targetUrl=XS` : `${url}?targetUrl=XS`;

    await chrome.tabs.update(tabId, { url: finalUrl });
    await log("Загружаем страницу товара: " + finalUrl);

    await waitTabReady(tabId);
    await waitForSelector(tabId, "[class*='productSummary']", 7000);
    await waitForWBRender(tabId);

    const prices = await fetchWBPrices(tabId);
    await log("Цены: " + JSON.stringify(prices));

    return prices;   
}


async function runScraperCycle() {
    const state = await getState();

    if (!state.enabled) {
        await log("Скрапер выключен, цикл пропущен");
        return;
    }

    if (isProcessing) {
        await log("Цикл уже выполняется, пропускаем повторный запуск");
        return;
    }

    isProcessing = true;

    try {
        await setState({
            lastRunAt: Date.now(),
            lastError: null
        });

        const networkOk = await isNetworkAvailable();
        if (!networkOk) {
            throw new Error("Нет интернета или API недоступен");
        }

        const models = await fetchModels();
        await log("Товаров: " + models.length);

        for (const m of models) {
            const freshState = await getState();
            if (!freshState.enabled) {
                await log("Скрапер остановлен пользователем");
                break;
            }

            await log("Парсим SKU: " + m.sku);

            try {
                const prices = await fetchPriceViaWB(m.url);

                if (prices.rcPrice || prices.cardPrice) {
                    await sendPriceToAPI(m.sku, prices);
                } else {
                    await log("Цена не найдена для SKU: " + m.sku);
                }
            } catch (err) {
                await log(`Ошибка при обработке SKU ${m.sku}: ${err.message}`);
            }
        }

        await setState({
            lastSuccessAt: Date.now(),
            lastError: null
        });

        await log("Цикл завершён");
    } catch (err) {
        await setState({
            lastError: err.message || String(err)
        });

        await log("Ошибка цикла: " + (err.message || String(err)));
    } finally {
        isProcessing = false;
    }
}





// --------------------------------------------

/*async function runScraper() {
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
}*/

// ---------------- START / STOP ----------------

async function startScraping() {
    await waitConfig();
    await ensureAlarm();

    await setState({
        enabled: true,
        lastError: null
    });

    await log("Скрапер включён");

    runScraperCycle().catch(async err => {
        await log("Ошибка при запуске цикла: " + (err.message || String(err)));
    });
}

async function stopScraping() {
    await setState({
        enabled: false
    });

    await log("Скрапер выключен");
}

// ---------------- EVENTS ----------------

chrome.runtime.onInstalled.addListener(async () => {
    await loadConfig();
    await loadLogsFromStorage();
    await ensureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
    await loadConfig();
    await loadLogsFromStorage();
    await ensureAlarm();

    const state = await getState();
    if (state.enabled) {
        await log("Автовосстановление после запуска браузера");
        runScraperCycle().catch(() => {});
    }
});

chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name !== ALARM_NAME) return;

    const state = await getState();
    if (!state.enabled) return;

    runScraperCycle().catch(async err => {
        await log("Ошибка alarm-цикла: " + (err.message || String(err)));
    });
});


// --------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        if (msg.action === "startScraping") {
            await startScraping();
            sendResponse({ ok: true });
            return;
        }

        if (msg.action === "stopScraping") {
            await stopScraping();
            sendResponse({ ok: true });
            return;
        }

        if (msg.action === "getLogs") {
            await loadLogsFromStorage();
            sendResponse({ ok: true, logs: LOGS });
            return;
        }

        if (msg.action === "getStatus") {
            const state = await getState();
            sendResponse({ ok: true, state, isProcessing });
            return;
        }

        sendResponse({ ok: false, error: "Unknown action" });
    })();

    return true;
});

// ---------------- INIT ----------------

(async () => {
    await loadConfig();
    await loadLogsFromStorage();
    await ensureAlarm();

    const state = await getState();
    if (state.enabled) {
        runScraperCycle().catch(async err => {
            await log("Ошибка автозапуска: " + (err.message || String(err)));
        });
    }
})();