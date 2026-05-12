// netlify/functions/scheduled-stories.js
// Função agendada que roda 4 vezes por dia automaticamente
// Chama post-instagram-stories.js no horário correto

const HORARIOS_CATEGORIA = {
  '08:00': 'bom-dia',
  '12:00': 'conteudos',
  '16:30': 'motoboy',
  '19:00': 'empresa'
};

// Netlify Scheduled Function (Cron syntax)
// Configurado no netlify.toml com schedule
exports.handler = async function(event, context) {
  // Pega hora UTC e ajusta pra BRT (-3h Brasília)
  const agoraUTC = new Date();
  const agoraBR = new Date(agoraUTC.getTime() - (3 * 60 * 60 * 1000));
  const horaAtual = `${String(agoraBR.getHours()).padStart(2, '0')}:${String(agoraBR.getMinutes()).padStart(2, '0')}`;
  
  console.log(`⏰ Scheduled function rodando às ${horaAtual} BRT`);
  
  // Encontra horário mais próximo dos 4 horários cadastrados (tolerância 10 min)
  let melhorHorario = null;
  let menorDiff = Infinity;
  
  for (const horario of Object.keys(HORARIOS_CATEGORIA)) {
    const [hh, mm] = horario.split(':').map(Number);
    const minHorario = hh * 60 + mm;
    const minAgora = agoraBR.getHours() * 60 + agoraBR.getMinutes();
    const diff = Math.abs(minHorario - minAgora);
    
    if (diff <= 10 && diff < menorDiff) {
      menorDiff = diff;
      melhorHorario = horario;
    }
  }
  
  if (!melhorHorario) {
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: `Não é horário de postar (${horaAtual} BRT). Horários: 08:00, 12:00, 16:30, 19:00`,
        skipped: true 
      })
    };
  }
  
  const categoria = HORARIOS_CATEGORIA[melhorHorario];
  console.log(`📱 Postando categoria "${categoria}" pras 9 cidades`);
  
  // Chama a função principal de postagem
  try {
    const siteUrl = process.env.URL || 'https://gami-marketing.netlify.app';
    const r = await fetch(`${siteUrl}/.netlify/functions/post-instagram-stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        horario: melhorHorario,
        categoria: categoria,
        modo: 'auto'
      })
    });
    
    const data = await r.json();
    
    console.log(`✅ Postagem concluída:`, JSON.stringify(data));
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        executado_em: agoraBR.toISOString(),
        horario_detectado: melhorHorario,
        categoria: categoria,
        resultado: data
      })
    };
  } catch (err) {
    console.error('❌ Erro na scheduled function:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
