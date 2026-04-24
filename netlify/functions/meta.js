const https = require('https');

const TOKEN   = 'EAAYlZCLBk17EBREN22qH5CpZAhsje6xIp3CwWahcSckdYihzWftVIZCWZC3xlwdI0QeqLPXuzi22IIdZABrkOeVlTBEjXgGL9mNZBmSsYpTxE7wItZAJrqCyRa2diy03ec91x9eINeixezRUgrye6ajkOYKR155SAydgZCjjqsuA97lqhZA7Df4cad4f23kldZB5sRRJO7poTdcNAM';
const ACCOUNT = 'act_1130346225232397';
const API     = 'graph.facebook.com';

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const endpoint = event.queryStringParameters?.endpoint || 'campaigns';

  try {
    let data;

    if (endpoint === 'campaigns') {
      const url = `https://${API}/v19.0/${ACCOUNT}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time&limit=50&access_token=${TOKEN}`;
      data = await fetchURL(url);

    } else if (endpoint === 'insights') {
      // Expanded fields: link clicks, cost per result, spend, impressions, reach, ctr, cpm, actions
      const url = `https://${API}/v19.0/${ACCOUNT}/insights?fields=campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,ctr,cpm,cpp,cost_per_inline_link_click,actions,cost_per_action_type,frequency&date_preset=last_30d&level=campaign&limit=50&access_token=${TOKEN}`;
      data = await fetchURL(url);

    } else if (endpoint === 'adsets') {
      const campId = event.queryStringParameters?.campaign_id || '';
      const url = `https://${API}/v19.0/${campId}/adsets?fields=id,name,status,daily_budget,targeting&access_token=${TOKEN}`;
      data = await fetchURL(url);

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Endpoint inválido' }) };
    }

    if (data.error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: data.error.message, code: data.error.code }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
