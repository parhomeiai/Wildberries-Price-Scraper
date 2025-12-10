document.getElementById("start").onclick = () =>
    chrome.runtime.sendMessage({ action: "startScraping" });

document.getElementById("stop").onclick = () =>
    chrome.runtime.sendMessage({ action: "stopScraping" });

document.getElementById("reload").onclick = () =>
    chrome.runtime.sendMessage({ action: "getLogs" });

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "status") {
        document.getElementById("status").textContent = msg.text;
    }
    if (msg.action === "uiLog") {
        const log = document.getElementById("log");
        log.textContent += msg.text + "\n";
        log.scrollTop = log.scrollHeight;
    }
    if (msg.action === "logs") {
        const log = document.getElementById("log");
        log.textContent = (msg.logs || []).join("\n");
        log.scrollTop = log.scrollHeight;
    }
});
