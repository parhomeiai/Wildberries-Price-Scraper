<h2>Плагин для Chrome - Парсинг цен с маркетплейса wildberries.ru</h2>
<p>Получает sku от вашего API, ходит по страницам вида https://www.wildberries.ru/catalog/{sku}/detail.aspx и отправляет цены на ваш сервер в формате:</p>
<code>[
  {
    {sku}, 
    rcPrice: {обычная цена},
    cardPrice: {цена по карте wb},
    strikePrice: {зачеркнутая цена} 
  }
]
</code>
<br>
<p>
Перед использованием переименуйте config_example.json в config.json и установите свои параметры.
</p>
<ul>
<li>baseUrl - адрес вашего сервера API;</li>
<li>listEndpoint - сервис для получения списка sku;</li>
<li>priceEndpoint - сервис для отправки цен;</li>
<li>cycleDelay - задержка между запуском циклов парсинга;</li>
<li>logEnabled - вкл/выкл. логирование;</li>
<li>saveLogs - вкл/выкл. хранение логов</li>
</ul>
