// Netlify Function: proxy seguro pro OpenWeatherMap.
// Mantém a chave em env var (OPENWEATHER_API_KEY) em vez de expor no front.
//
// USO PELO FRONTEND:
//   GET /.netlify/functions/clima?lat=-3.7172&lon=-38.5433
//   GET /.netlify/functions/clima?cidades=all   ← retorna o array completo das 11 cidades
//
// VARIÁVEIS DE AMBIENTE (Netlify):
//   OPENWEATHER_API_KEY  — chave gratuita do OpenWeatherMap

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  // Cache no edge por 30 minutos (clima não muda a cada segundo)
  'Cache-Control': 'public, max-age=1800',
};

// Lista das 11 cidades operantes da Gâmi (mesma do dashboard)
const CIDADES = [
  { nome:'Fortaleza',    uf:'CE', lat:-3.7172,  lon:-38.5433 },
  { nome:'Recife',       uf:'PE', lat:-8.0476,  lon:-34.8770 },
  { nome:'Maceió',       uf:'AL', lat:-9.6498,  lon:-35.7089 },
  { nome:'João Pessoa',  uf:'PB', lat:-7.1195,  lon:-34.8450 },
  { nome:'Natal',        uf:'RN', lat:-5.7945,  lon:-35.2110 },
  { nome:'Aracaju',      uf:'SE', lat:-10.9472, lon:-37.0731 },
  { nome:'São Luís',     uf:'MA', lat:-2.5391,  lon:-44.2829 },
  { nome:'Cuiabá',       uf:'MT', lat:-15.6014, lon:-56.0979 },
  { nome:'Teresina',     uf:'PI', lat:-5.0892,  lon:-42.8019 },
  { nome:'Vitória',      uf:'ES', lat:-20.3155, lon:-40.3128 },
  { nome:'Campo Grande', uf:'MS', lat:-20.4486, lon:-54.6295 },
];

function calcChuvaPct(weatherData){
  if(!weatherData) return 0;
  if(weatherData.rain && (weatherData.rain['1h'] || weatherData.rain['3h'])) return 80;
  const main = weatherData.weather && weatherData.weather[0] && weatherData.weather[0].main;
  if(/Thunderstorm/i.test(main || '')) return 90;
  if(/Rain|Drizzle/i.test(main || '')) return 70;
  if(/Cloud/i.test(main || '')) return 25;
  if(/Clear|Sun/i.test(main || '')) return 5;
  return 10;
}

async function fetchOne(lat, lon, apiKey){
  const url = 'https://api.openweathermap.org/data/2.5/weather'
    + '?lat=' + lat
    + '&lon=' + lon
    + '&units=metric&lang=pt_br&appid=' + apiKey;
  const r = await fetch(url);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if(!apiKey){
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({
        error: 'OPENWEATHER_API_KEY não configurada nas env vars do Netlify',
        hint: 'Site settings → Environment variables → adicionar OPENWEATHER_API_KEY com a chave grátis de openweathermap.org/api'
      }),
    };
  }

  const params = event.queryStringParameters || {};

  // ---------- MODO ALL: retorna 11 cidades em paralelo ----------
  if (params.cidades === 'all') {
    try {
      const resultados = await Promise.all(CIDADES.map(async (c) => {
        try {
          const d = await fetchOne(c.lat, c.lon, apiKey);
          return {
            nome: c.nome,
            uf: c.uf,
            temp: d.main && Math.round(d.main.temp),
            sensacao: d.main && Math.round(d.main.feels_like),
            condicao: d.weather && d.weather[0] && d.weather[0].description,
            condicao_main: d.weather && d.weather[0] && d.weather[0].main,
            chuvaPct: calcChuvaPct(d),
            umidade: d.main && d.main.humidity,
            vento: d.wind && Math.round(d.wind.speed * 3.6), // m/s → km/h
          };
        } catch (e) {
          return { nome: c.nome, uf: c.uf, error: e.message };
        }
      }));
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ cidades: resultados }) };
    } catch (err) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ---------- MODO PONTUAL: lat/lon ----------
  const lat = params.lat;
  const lon = params.lon;
  if (!lat || !lon) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Use cidades=all OU lat=…&lon=…' }) };
  }

  try {
    const d = await fetchOne(lat, lon, apiKey);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        temp: d.main && Math.round(d.main.temp),
        sensacao: d.main && Math.round(d.main.feels_like),
        condicao: d.weather && d.weather[0] && d.weather[0].description,
        condicao_main: d.weather && d.weather[0] && d.weather[0].main,
        chuvaPct: calcChuvaPct(d),
        umidade: d.main && d.main.humidity,
        vento: d.wind && Math.round(d.wind.speed * 3.6),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
