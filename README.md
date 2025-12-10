Парсинг цен с маркетплейса wildberries.ru
Получает sku от вашего API, ходит по страницам вида https://www.wildberries.ru/catalog/{sku}/detail.aspx и отправляет цены на ваш сервер в формате:
[
  {
    {sku}, 
    rcPrice: {обычная цена},
    cardPrice: {цена по карте wb},
    strikePrice: {зачеркнутая цена} 
  }
]

Перед использованием переименуйте config_example.json в config.json и установите свои параметры.
baseUrl - адрес вашего сервера API;
listEndpoint - сервис для получения списка sku;
priceEndpoint - сервис для отправки цен;
cycleDelay - задержка между запуском циклов парсинга;
logEnabled - вкл/выкл. логирование;
saveLogs - вкл/выкл. хранение логов
