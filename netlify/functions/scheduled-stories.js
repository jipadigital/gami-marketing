// netlify/functions/scheduled-stories.js
// Função agendada que roda várias vezes por dia automaticamente
// Lógica nova (v2 - 14/05/2026):
//   - 07:00 → Bom Dia (Ter-Dom) ou Ótima Semana (Seg)
//   - 12:00 → Outra (todo dia)
//   - 16:30 → Motoboy (todo dia)
//   - 18:00 → Empresa (todo dia)
//   - 19:00 → Fim de Semana (só Sex)

// Mapeia: { horário → função que retorna categoria conforme dia da semana }
// diaSemana: 0=Dom, 1=Seg, 2=Ter, 3=Qua, 4=Qui, 5=Sex, 6=Sáb
const REGRAS_HORARIO = {
  '07:00': function(diaSemana) {
    if (diaSemana === 1) return 'otima-semana';  // Segunda
    return 'bom-dia';                             // Terça a Domingo
  },
  '12:00': function(diaSemana) {
    return 'outra';  // Todo dia
  },
  '16:30': function(diaSemana) {
    return 'motoboy';  // Todo dia
  },
  '18:00': function(diaSemana) {
    return 'empresa';  // Todo dia
  },
  '19:00': function(diaSemana) {
    if (diaSemana === 5) return 'fim-de-semana';  // Só Sexta
    return null;  // Outros dias: NÃO posta
  }
};

const DIAS_NOME = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

exports.handler = async function(event, context) {
  // Pega hora UTC e ajusta pra BRT (-3h Brasília)
  const agoraUTC = new Date();
  const agoraBR = new Date(agoraUTC.getTime() - (3 * 60 * 60 * 1000));
  const horaAtual = `${String(agoraBR.getHours()).padStart(2, '0')}:${String(agoraBR.getMinutes()).padStart(2, '0')}`;
  const diaSemana = agoraBR.getDay();
  const nomeDia = DIAS_NOME[diaSemana];
  
  console.log(`⏰ Scheduled rodando ${nomeDia} às ${horaAtual} BRT`);
  
  // Encontra horário mais próximo (tolerância 10 min)
  let melhorHorario = null;
  let menorDiff = Infinity;
  
  for (const horario of Object.keys(REGRAS_HORARIO)) {
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
        message: `Não é horário de postar (${horaAtual} BRT, ${nomeDia})`,
        horarios_validos: ['07:00','12:00','16:30','18:00','19:00 (só sex)'],
        skipped: true 
      })
    };
  }
  
  // Aplica regra do dia da semana
  const categoria = REGRAS_HORARIO[melhorHorario](diaSemana);
  
  if (!categoria) {
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: `Horário ${melhorHorario} não aplica em ${nomeDia}`,
        horario_detectado: melhorHorario,
        dia_semana: nomeDia,
        skipped: true 
      })
    };
  }
  
  console.log(`📱 Postando "${categoria}" pras 9 cidades (${nomeDia} ${melhorHorario})`);
  
  try {
    const siteUrl = process.env.URL || 'https://gami-marketing.netlify.app';
    const r = await fetch(`${siteUrl}/.netlify/functions/post-instagram-stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        horario: melhorHorario,
        categoria: categoria,
        dia_semana: diaSemana,
        modo: 'auto'
      })
    });
    
    const data = await r.json();
    console.log(`✅ Postagem concluída:`, JSON.stringify(data));
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        executado_em: agoraBR.toISOString(),
        dia_semana: nomeDia,
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
