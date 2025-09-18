// server.js (ESM) — GlicoCerto
// Rotas: /api/env, /api/paciente/:userId (GET), /api/paciente (POST)
//        /api/ns/latest/:userId (GET)
//        /api/chat (POST), /api/chat-image (POST)
//        /api/refeicoes (GET), /api/refeicoes/serie (GET), /api/refeicoes/:id (DELETE)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import crypto from "crypto";

dotenv.config();

// __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Avisos de env
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn("⚠️  SUPABASE_URL/SUPABASE_ANON_KEY ausentes no .env");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY ausente — a análise por IA usará fallback simples.");
}

// App
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public"))); // serve ./public
//     ^ mantém igual ao seu original (está ok). :contentReference[oaicite:2]{index=2}

// SDKs
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Supabase client com JWT do request (RLS)
function supabaseFromReq(req) {
  const token = req.headers?.authorization?.split(" ")[1] || null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
function num(s){ const n = parseFloat(String(s).replace(/\./g,'').replace(',','.')); return Number.isFinite(n)?n:0; }



// Utils
const r0 = (n) => Math.round(Number(n || 0));
const sha1Hex = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
const stripFences = (s) => String(s || "").replace(/```html|```/g, "").trim();

// Timeout helper (promessa com tempo-limite)
function withTimeout(promise, ms = 45000, label = "Timeout") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}
// ---- System prompt para análise de refeição ----
// ---- System prompt para análise de refeição ----
// ---- System prompt para análise de refeição ----
// ---- System prompt para análise de refeição ----
function systemPrompt(cfg) {
  const icr     = Number(cfg?.icr || cfg?.insulina_cho || 10);     // g CHO por 1U
  const isf     = Number(cfg?.isf || cfg?.glicose_insulina || 50); // mg/dL por 1U
  const target  = Number(cfg?.target || 100);                      // mg/dL
  const strat   = (cfg?.pg_strategy || "regular_now").trim();      // "regular_now" ou "split_rapid"
  const pgPct = Math.max(0, Math.min(100, Number(cfg?.pct_cal_pf ?? 100))); // %
  const rapid = String(cfg?.insulina_rapida || 'Fiasp');
  return `
  Você é um assistente para contagem de carboidratos e cálculo de bolus em diabetes (pt-BR).
  Use as regras e valores do manual de contagem de carboidrato da SBD (sociedade Brasileira de Diabetes) e entregue **HTML puro** (sem Markdown) com as seções abaixo.
  Os números devem ser coerentes e consistentes entre si.

  Parâmetros do paciente (use em todas as contas):
  • ICR (g/1U): ${icr}
  • ISF (mg/dL/1U): ${isf}
  • Glicemia alvo: ${target} mg/dL
  • Estratégia proteína+gordura: ${strat}  
  • pct_cal_pf (% das kcal de PROTEÍNA a considerar): ${pgPct}%

  Regras para proteína+gordura (SBD solicitado):
  - kcal proteína = proteina_total_g × 4; kcal gordura = gordura_total_g × 9.
  - CHO eq da proteína = (kcal proteína × ${pgPct}%) ÷ 4  == proteina_total_g × (${pgPct}/100)
  - CHO eq da gordura  = (kcal gordura × 10%) ÷ 4       == gordura_total_g × 0.225
  - Portanto: pg_cho_equiv_g = round( proteina_total_g*(${pgPct}/100) + gordura_total_g*0.225 , 1 )
  - Se ${strat} == "regular_now": mostre dose com Insulina Regular = pg_cho_equiv_g ÷ ${icr}.
  - Se ${strat} == "split_rapid": não usar Regular agora; informe a dose equivalente separada para 2–3h depois (mas mantenha pg_cho_equiv_g no JSON).
 
  TAREFAS
  1) Identificar/estimar os itens da refeição (texto ou foto), com quantidades.
  2) Para cada item, estimar:
    - CHO estimado (SBD), em gramas.
    - kcal aproximadas do item (pode estimar por porções usuais se não houver rotulagem).
  3) Calcular:
    - Carboidratos totais da refeição (em gramas) como soma dos itens.
    - Energia associada a proteína+gordura (kcal) da refeição (ex.: carnes, queijos, óleo de preparo).
    - "pg_cho_equiv_g" (equivalente CHO proveniente de proteína+gordura) segundo sua regra interna.
    - Dose por carboidrato = CHO_totais ÷ ICR.
    - Correção = máx(0, (glicemia_atual – alvo) ÷ ISF).
    - Dose proteína/gordura (se ${strat} == "regular_now") = pg_cho_equiv_g ÷ ICR.
    - Total bolus = arredondar(Dose por carbo + Correção) e, se aplicável, arredondar a dose de Regular separadamente.
    - Calorias totais da refeição (≈ soma das kcal dos itens, informe como “≈ xxx kcal”).
  4) Renderizar o resultado **somente** neste HTML (sem comentários extras), exatamente neste formato e ordem:

  <div class="details-clean">
    <h3>🍽️ Refeição informada</h3>
    <div class="table-wrap">
      <table class="gc-table">
        <thead>
          <tr><th>Alimento</th><th>Quantidade</th><th>CHO</th><th>kcal aprox</th><th>Proteína</th><th>Gordura</th></tr>
        </thead>
        <tbody>
          <!-- Uma linha por item identificado -->
          <!-- Exemplo:
          <tr><td>Arroz branco</td><td>100g</td><td>28g</td><td>~130 kcal</td><td>7g</td><td>1g</td></tr>
          -->
        </tbody>
      </table>
    </div>
    <h3>📊 Totais</h3>
    <ul>
      <!-- Escreva a soma mostrando a conta -->
      <li><b>Carboidratos:</b> a + b + c = <b>XX g CHO</b></li>
      <li><b>Proteínas:</b> some todas as proteínas dos itens ≈ <b>YY g</b></li>
      <li><b>Gorduras:</b> some todas as gorduras dos itens ≈ <b>ZZ g</b></li>
      <li>
        <b>Proteínas + Gorduras (equivalente CHO):</b><br>
        Proteína: (YY g) × 4 = KCAL_P<br>
        Gordura: (ZZ g) × 9 = KCAL_G<br>
        Aplique ${pgPct}% sobre KCAL_P e 10% sobre KCAL_G, depois some e ÷ 4 → <b>EQ_PG g CHO</b>
      </li>
    </ul>

    <h3>💉 Insulina</h3>
    <ul>
      <li><b>${rapid} (cho):</b> CHO_totais ÷ ${icr} = X,U ⇒ <b>YU</b></li>
      <li><b>Correção (glicemia):</b> (G – ${target}) ÷ ${isf} = Z,U ⇒ <b>WU</b></li>
      <!-- Se ${strat} == "regular_now", calcule e mostre a linha abaixo; caso contrário, escreva em itálico que não será aplicada agora -->
      <li><b>Insulina R (proteína/gordura):</b> pg_cho_equiv_g ÷ ${icr} = P,U ⇒ <b>QU</b></li>
      <li><b>Total bolus:</b>  ${rapid}(YU) + ${strat==="regular_now" ? "Regular(QU) = <b>TU</b>" : "Regular(não aplicável agora) = <b>YU</b>"} </li>
    </ul>

    <h3>✅ Resumo da dose</h3>
    <ul>
      <li><b>${rapid}:</b> YU + WU = <b>TU</b></li>
      ${strat === "regular_now" ? "<li><b>Insulina R:</b> QU</li>" : "<li><b>Insulina " + rapid + " em 2 - 3 horas:</b> QU</li>"}
      <li><b>Total bolus:</b> TU+QU </li>
      <li><b>Calorias da refeição:</b> ≈ KK kcal</li>
    </ul>
  </div>

  REGRAS DE APRESENTAÇÃO
  - Use o símbolo “⇒” para mostrar o arredondamento (ex.: 3,7U ⇒ 4U).
  - Mostre 1 casa decimal nas contas intermediárias quando útil; doses finais sempre em inteiros.
  - Use “g” para gramas e “kcal” para energia. Escreva “CHO” para carboidratos.
  - Não use Markdown; **somente HTML**. Não repita o enunciado nem explique o que você está fazendo.
  - Se não conseguir identificar algum item ou kcal, estime de forma conservadora e deixe claro com “~”.

  BLOCO JSON OBRIGATÓRIO
  Ao final do HTML inclua um bloco <pre>{...}</pre> contendo JSON com:
  {
    "carbo_g": <CHO_totais_liquidos>,             // em g; se puder, aplique SBD líquido
    "carbo_totais_g": <opcional>,                 // totais antes de ajuste de fibras/polióis
    "fibras_g": <opcional>,
    "poliois_g": <opcional>,
    "pg_cho_equiv_g": <equivalente CHO de proteína+gordura em g>,
    "kcal_total": <kcal aproximadas da refeição>,
    "resumo": "<descrição curta da refeição, ex.: '100g arroz, 40g feijão, 100g bife'>"
  }

  OBSERVAÇÕES IMPORTANTES
  - Se tiver dados para “Carboidratos líquidos (SBD)”, informe em "carbo_g". Se não, reporte "carbo_g" pelos melhores dados que tiver.
  - Valores devem ser consistentes com a tabela e com as doses apresentadas.
  - Nunca use cercas de código (sem \`\`\`), apenas HTML + o <pre>{...}</pre> final.
  `;
}




// Extrai JSON do <pre>…</pre> (carbo_g, pg_cho_equiv_g, resumo)
// Substitua a função inteira por esta
// server.js — perto do topo, utilidades
function pickFromPre(html) {
  let carbo_g = 0, pg_cho_equiv_g = 0, resumo = "";
  const parseNum = (v) => {
    if (v == null) return 0;
    const s = String(v).replace(/\./g, '').replace(',', '.'); // "1.234,5" -> "1234.5"
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };
  try {
    const m = String(html || "").match(/<pre[^>]*>\s*({[\s\S]*?})\s*<\/pre>/i);
    if (m && m[1]) {
      const j = JSON.parse(m[1]);

      // chaves possíveis
      for (const k of ["carbo_g","carbo_liquido_g","carbo_liquidos_g","cho_g"]) {
        if (k in j) { carbo_g = parseNum(j[k]); break; }
      }
      for (const k of ["pg_cho_equiv_g","pg_cho_equiv","pg_eq_g","pg_eq","pg_cho_g"]) {
        if (k in j) { pg_cho_equiv_g = parseNum(j[k]); break; }
      }
      if ("resumo" in j) resumo = String(j.resumo || "");
    }
  } catch {}
  return { carbo_g, pg_cho_equiv_g, resumo };
}
// Tenta extrair proteína e gordura (em g) do HTML dos detalhes (tabela ou linhas tipo "Proteína total: X g")
function computePgFromHtml(html, percent = 1.0) {
  const txt = String(html || "");
  const toNum = (s) => {
    const n = parseFloat(String(s).replace(/\./g,'').replace(',','.'));
    return Number.isFinite(n) ? n : 0;
  };

  let protG = 0, gordG = 0;

  // 1) Procura "Proteína total: 15 g" / "Gordura total: 30 g"
  const mProt = txt.match(/prote[ií]na(?:\s+total)?\s*[:\-]?\s*([\d\.,]+)\s*g/i);
  const mGord = txt.match(/gordura(?:\s+total)?\s*[:\-]?\s*([\d\.,]+)\s*g/i);
  if (mProt) protG = toNum(mProt[1]);
  if (mGord) gordG = toNum(mGord[1]);

  // 2) Se não achou totais, soma por linhas da tabela (qualquer coluna com "prote" e "gordu/total fat")
  if (!(protG>0) || !(gordG>0)) {
    // pega linhas da tabela: <tr>...</tr>
    const rows = txt.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let pSum = 0, gSum = 0;
    for (const row of rows) {
      // captura células
      const cells = Array.from(row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map(m=>m[1]);
      if (cells.length < 2) continue;
      // tenta mapear pelos cabeçalhos quando presentes
      const header = cells.map(c => c.replace(/<[^>]+>/g,'').trim().toLowerCase());
      // heurística: procura campos que parecem números com "g"
      for (let i=0; i<cells.length; i++) {
        const plain = header[i];
        const val   = toNum(cells[i].replace(/<[^>]+>/g,'').match(/([\d\.,]+)/)?.[1] || "");
        if (!val) continue;
        if (/prote/i.test(plain)) pSum += val;
        if (/gordu|fat/i.test(plain)) gSum += val;
      }
    }
    if (pSum>0) protG = protG || pSum;
    if (gSum>0) gordG = gordG || gSum;
  }

  const kcalP = protG*4;
  const kcalG = gordG*9;
  // Regra SBD solicitada:
  // CHOeq_proteina = (kcalP * percent) / 4  == protG * percent
  // CHOeq_gordura  = (kcalG * 0.10) / 4     == gordG * 0.225
  const choEq = (protG * (percent || 0)) + (gordG * 0.225);
  return { protG, gordG, choEq, kcalP, kcalG, kcal: kcalP + kcalG };
}


/* ======================== ENV ======================== */
app.get("/api/env", (req, res) => {
  res.json({
    ok: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    // openai não é exposta ao front por segurança
  });
});

/* ================== PACIENTE (CRUD) ================== */
app.get("/api/paciente/:userId", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId } = req.params;
    const { data, error } = await supabase
      .from("patient_settings")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;
    res.json({ ok: true, data: data || null });
  } catch (e) {
    console.error("[GET /api/paciente/:userId]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/paciente", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, settings } = req.body || {};
    if (!userId || !settings) {
      return res.status(400).json({ ok: false, error: "userId e settings são obrigatórios" });
    }
    const payload = { user_id: userId, ...settings, updated_at: new Date().toISOString() };
    const { error } = await supabase.from("patient_settings").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/paciente]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ==================== NIGHTSCOUT ===================== */
async function fetchNightscoutLatest(nsUrl, nsSecret) {
  const base = String(nsUrl || "").replace(/\/+$/, "");
  const url = `${base}/api/v1/entries.json?count=1`;

  // tentativa 1: plaintext (algumas instâncias aceitam)
  let resp = await fetch(url, { headers: nsSecret ? { "API-SECRET": nsSecret } : {} });

  // fallback: SHA-1 no header api-secret
  if (resp.status === 401 || resp.status === 403) {
    const headers = nsSecret ? { "api-secret": sha1Hex(nsSecret) } : {};
    resp = await fetch(url, { headers });
  }
  return resp;
}

app.get("/api/ns/latest/:userId", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId } = req.params;
    const { data: cfg, error } = await supabase
      .from("patient_settings")
      .select("nightscout_url, nightscout_api_secret")
      .eq("user_id", userId)
      .single();
    if (error && error.code !== "PGRST116") throw error;

    const nsUrl = cfg?.nightscout_url?.trim();
    const nsSecret = cfg?.nightscout_api_secret?.trim();
    if (!nsUrl) return res.json({ ok: false, error: "Nightscout não configurado" });

    const r = await fetchNightscoutLatest(nsUrl, nsSecret);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: `Nightscout HTTP ${r.status}` });
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return res.json({ ok: false, error: "Sem dados" });

    const e = arr[0];
    res.json({
      ok: true,
      data: {
        mgdl: Math.round(e.sgv ?? e.mgdl ?? e.glucose ?? 0),
        trend: e.direction ?? e.trend ?? null,
        date: new Date(e.dateString || e.date).toISOString(),
      },
    });
  } catch (e) {
    console.error("[GET /api/ns/latest]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========== Upload Storage (dataURL -> arquivo) ============ */
function dataUrlParse(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return {
    mime: m[1],
    buf: Buffer.from(m[2], "base64"),
    ext: (m[1].split("/")[1] || "jpg").split("+")[0],
  };
}
async function uploadMealPhoto(supabase, userId, dataUrl) {
  const p = dataUrlParse(dataUrl);
  if (!p) return null;
  const key = `refeicoes/${userId}/${Date.now()}.${p.ext}`;
  const up = await supabase.storage.from("refeicoes").upload(key, p.buf, {
    contentType: p.mime,
    upsert: true,
  });
  if (up.error) throw up.error;
  const pub = supabase.storage.from("refeicoes").getPublicUrl(key);
  return pub?.data?.publicUrl || null;
}
// ======== REGRAS SBD: proteína % do paciente + gordura 10% (kcal) ========
function numBR(s){ const n = parseFloat(String(s||'').replace(/\./g,'').replace(',','.')); return Number.isFinite(n)?n:0; }

// Tenta somar proteína(g) e gordura(g) a partir da tabela da resposta (fallback: 0)
function parseProtGordFromTable(html){
  let prot = 0, gord = 0;
  // <td>...Proteína</td> e <td>...Gordura</td> por linha da tabela
  const rows = String(html).match(/<tbody>[\s\S]*?<\/tbody>/i);
  if(rows){
    const tr = rows[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for(const r of tr){
      const tds = r.match(/<td[\s\S]*?<\/td>/gi) || [];
      if(tds.length >= 6){
        const protTd = tds[4].replace(/<[^>]+>/g,'').trim();  // 5a coluna = Proteína
        const gordTd = tds[5].replace(/<[^>]+>/g,'').trim();  // 6a coluna = Gordura
        prot += numBR(protTd); // valores como "7g" ou "7"
        gord += numBR(gordTd);
      }
    }
  }
  return { prot_g: prot, gord_g: gord };
}

// Insere/atualiza a linha de “Proteínas/gorduras … → X g CHO” nos Totais
function patchPgTotals(html, prot_g, gord_g, kcalP, kcalG, kcalSum, choEq){
  const lp = `Proteínas: ${Math.round(prot_g)}g ×4 = ${Math.round(kcalP)} kcal`;
  const lg = `Gorduras: ${Math.round(gord_g)}g ×9 = ${Math.round(kcalG)} kcal`;
  const sum = `Proteína + Gordura: ${Math.round(kcalSum)} kcal → ${choEq.toFixed(1)} g CHO`;
  const li  = `<li><b>Proteínas/gorduras:</b> ${lp}; ${lg}; <b>${sum}</b></li>`;
  if (/<li><b>Proteínas\/gorduras:[\s\S]*?<\/li>/i.test(html)){
    return html.replace(/<li><b>Proteínas\/gorduras:[\s\S]*?<\/li>/i, li);
  }
  return html.replace(/(<li><b>Carboidratos:[\s\S]*?<\/li>)/i, `$1\n${li}`);
}

// Garante a regra SBD no HTML + JSON <pre> final (usa % do cadastro!)
function enforcePgRule(html, cfg){
  // % proteína DA ANAMNESE (campo pct_cal_pf); se não vier, mantém 100? Não: mantém 0 para não inventar.
  const protPct = Math.max(0, Math.min(100, Number(cfg?.pct_cal_pf ?? 0))); // ← vem do cadastro!  :contentReference[oaicite:1]{index=1}
  const icr     = Number(cfg?.icr || cfg?.insulina_cho || 10);              // g CHO por 1U  :contentReference[oaicite:2]{index=2}

  // 1) tentar ler proteína e gordura (g) da tabela
  const { prot_g, gord_g } = parseProtGordFromTable(html);

  // 2) kcal
  const kcalP = prot_g * 4;
  const kcalG = gord_g * 9;

  // 3) aplicar % do paciente (proteína) e 10% fixo (gordura)
  const kcalProtConsiderada = kcalP * (protPct/100);
  const kcalGordConsiderada = kcalG * 0.10;

  // 4) g CHO equivalentes (÷4)
  const pg_cho_equiv_g = (kcalProtConsiderada + kcalGordConsiderada) / 4;

  // 5) dose Regular (U)
  const doseRegular = icr > 0 ? (pg_cho_equiv_g / icr) : 0;

  // 6) Atualiza a seção "Totais"
  let out = patchPgTotals(html, prot_g, gord_g, kcalP, kcalG, (kcalProtConsiderada+kcalGordConsiderada), pg_cho_equiv_g);

  // 7) Ajusta o bloco <pre>{...}</pre> garantindo o campo pg_cho_equiv_g correto
  out = out.replace(
    /<pre[^>]*>\s*({[\s\S]*?})\s*<\/pre>/i,
    (m, jstr) => {
      try {
        const j = JSON.parse(jstr);
        j.pg_cho_equiv_g = Number(pg_cho_equiv_g.toFixed(1));
        return `<pre>${JSON.stringify(j)}</pre>`;
      } catch { return m; }
    }
  );

  return { html: out, pg_cho_equiv_g, doseRegular, protPct };
}

/* ===================== CHAT (TEXTO) ===================== */
app.post("/api/chat", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, message, glicemia, pg_strategy, tipo } = req.body || {};
    if (!userId || typeof glicemia !== "number") {
      return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });
    }

    const { data: cfgRaw } = await supabase.from("patient_settings").select("*").eq("user_id", userId).single();
    const cfg = { ...(cfgRaw || {}), pg_strategy: pg_strategy || cfgRaw?.pg_strategy || "regular_now" };

    let detalhes_html = "";
    let carbo_g = 0, pg_cho_equiv_g = 0, refeicao_resumo = String(message || "").trim();

    if (openai) {
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt(cfg) },
            { role: "user", content: `Refeição textual: ${refeicao_resumo}\nGlicemia: ${glicemia} mg/dL\nTipo: ${tipo || "outro"}` },
          ],
        }),
        45000,
        "Timeout IA (chat-texto)"
      );
      const raw = completion.choices?.[0]?.message?.content || "";
      detalhes_html = stripFences(raw);
      const parsed = pickFromPre(raw);
      carbo_g = parsed.carbo_g;
      pg_cho_equiv_g = parsed.pg_cho_equiv_g;
      if (parsed.resumo) refeicao_resumo = parsed.resumo;

      // === Fallback P+G (a partir do HTML/tabela) ===
      const percent = Math.max(0, Math.min(100, Number(cfg?.pct_cal_pf ?? 100))) / 100;
      if (!(pg_cho_equiv_g > 0)) {
        const r = computePgFromHtml(detalhes_html, percent);   // retorna { protG, gordG, choEq, ... }
        pg_cho_equiv_g = r.choEq;                              // choEq = protG*(%/100) + gordG*0.225
        // (opcional) detalhes_html = patchPgTotals(..., r.kcalP, r.kcalG, r.kcal, pg_cho_equiv_g);
      }
      // ==============================================



    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
    }

    const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat = cfg?.pg_strategy || "regular_now";

    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? pg_cho_equiv_g / icr : 0;

    const insertPayload = {
      user_id: userId,
      data_hora: new Date().toISOString(),
      tipo: tipo || "outro",
      descricao: refeicao_resumo || String(message || "").trim(),
      glicemia: Number(glicemia),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: r0(doseCho + doseCor),
      dose_regular_pg: r0(dosePg),
      descricao_model: detalhes_html,
    };

    // grava; se falhar por tamanho do campo "descricao_model", tenta sem ele
    let { error: e1 } = await supabase.from("refeicoes").insert(insertPayload);
    if (e1) {
      const basic = { ...(insertPayload || {}) };
      delete basic.descricao_model;
      const retry = await supabase.from("refeicoes").insert(basic);
      if (retry.error) throw e1;
    }

    res.json({
      ok: true,
      input: { descricao: insertPayload.descricao, glicemia: Number(glicemia) },
      config: {
        insulina_rapida: cfg?.insulina_rapida || "Fiasp",
        insulina_cho: icr,
        glicose_insulina: isf,
        target,
        pg_strategy: strat,
      },
      totais: { carbo_g, pg_cho_equiv_g },
      detalhes_html,
    });
  } catch (e) {
    console.error("[POST /api/chat]", e);
    const msg = String(e?.message || "");
    if (msg.startsWith("Timeout")) {
      return res.status(504).json({ ok: false, error: "Timeout ao analisar a imagem." });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});


/* ===================== CHAT (IMAGEM) ===================== */
app.post("/api/chat-image", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, glicemia, tipo, pg_strategy, image_data_url, message } = req.body || {};
    if (!userId || typeof glicemia !== "number" || !image_data_url) {
      return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });
    }

    const { data: cfgRaw } = await supabase.from("patient_settings").select("*").eq("user_id", userId).single();
    const cfg = { ...cfgRaw, pg_strategy: pg_strategy || cfgRaw?.pg_strategy || "regular_now" };

    let detalhes_html = "";
    let carbo_g = 0, pg_cho_equiv_g = 0, refeicao_resumo = "[foto]";

    if (openai) {
      const userText =
        `Foto da refeição. Glicemia: ${glicemia} mg/dL. Tipo: ${tipo || "outro"}. ` +
        (message ? `Observações: ${message}` : "");

      const completion = await withTimeout(
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            { role: "system", content: systemPrompt(cfg) },
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: image_data_url } },
              ],
            },
          ],
        }),
        45000,"Timeout IA (chat-imagem)"
      );

      const raw = completion.choices?.[0]?.message?.content || "";
      detalhes_html = stripFences(raw);
      const parsed = pickFromPre(raw);
      carbo_g = parsed.carbo_g;
      pg_cho_equiv_g = parsed.pg_cho_equiv_g;
      if (parsed.resumo) refeicao_resumo = parsed.resumo;

      // === Fallback P+G (a partir do HTML/tabela) ===
      const percent = Math.max(0, Math.min(100, Number(cfg?.pct_cal_pf ?? 100))) / 100;
      if (!(pg_cho_equiv_g > 0)) {
        const r = computePgFromHtml(detalhes_html, percent);
        pg_cho_equiv_g = r.choEq;
      }

      // ==============================================
    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
      refeicao_resumo = String(message || "[foto]").trim();
    }

    // Upload foto para Storage (pode falhar sem travar o fluxo)
    let foto_url = null;
    try {
      foto_url = await uploadMealPhoto(supabase, userId, image_data_url);
    } catch (eUp) {
      console.warn('[uploadMealPhoto]', eUp?.message || eUp);
    }

    const icr = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat = cfg?.pg_strategy || "regular_now";

    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? pg_cho_equiv_g / icr : 0;

    const insertPayload = {
      user_id: userId,
      data_hora: new Date().toISOString(),
      tipo: tipo || "outro",
      descricao: refeicao_resumo || String(message || "").trim(),
      glicemia: Number(glicemia),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: r0(doseCho + doseCor),
      dose_regular_pg: r0(dosePg),
      descricao_model: detalhes_html,
      foto_url,
    };

    let { error: e1 } = await supabase.from("refeicoes").insert(insertPayload);
    if (e1) {
      const basic = { ...(insertPayload || {}) };
      delete basic.descricao_model;
      const retry = await supabase.from("refeicoes").insert(basic);
      if (retry.error) throw e1;
    }

    res.json({
      ok: true,
      input: { descricao: insertPayload.descricao, glicemia: Number(glicemia) },
      config: {
        insulina_rapida: cfg?.insulina_rapida || "Fiasp",
        insulina_cho: icr,
        glicose_insulina: isf,
        target,
        pg_strategy: strat,
      },
      totais: { carbo_g, pg_cho_equiv_g },
      detalhes_html,
    });
  } catch (e) {
    console.error("[POST /api/chat-image]", e);
    // Fallback gentil: devolve sem análise para o front não travar
    const { userId, glicemia, tipo, pg_strategy, message } = req.body || {};
    res.json({
      ok: true,
      input: { descricao: String(message || "[foto]").trim(), glicemia: Number(glicemia || 0) },
      config: {
        insulina_rapida: "Fiasp",
        insulina_cho: 10,
        glicose_insulina: 50,
        target: 100,
        pg_strategy: pg_strategy || "regular_now",
      },
      totais: { carbo_g: 0, pg_cho_equiv_g: 0 },
      detalhes_html: "<em>Não foi possível analisar a imagem agora. Tente novamente ou descreva a refeição em texto.</em>",
    });
  }
});

// ... depois que você tiver o `html` da IA:
const enforced = enforcePgRule(html, req.body?.config || {});
html = enforced.html; // resposta já corrigida

/* ===================== HISTÓRICO ===================== */
app.get("/api/refeicoes", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, start, end, tipo } = req.query || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId é obrigatório" });

    let q = supabase.from("refeicoes").select("*").eq("user_id", userId).order("data_hora", { ascending: false });
    if (start) q = q.gte("data_hora", new Date(start).toISOString());
    if (end)   q = q.lte("data_hora", new Date(end).toISOString());
    if (tipo && tipo !== "todos") q = q.eq("tipo", tipo);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, data: data || [] });
  } catch (e) {
    console.error("[GET /api/refeicoes]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/refeicoes/serie", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { userId, days = 30 } = req.query || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId é obrigatório" });

    const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const { data, error } = await supabase
      .from("refeicoes")
      .select("data_hora,glicemia,cho_total_g,dose_rapida_total")
      .eq("user_id", userId)
      .gte("data_hora", since)
      .order("data_hora", { ascending: true });
    if (error) throw error;

    // agrega por dia (média glicemia; soma carbo; soma insulina)
    const byDay = {};
    for (const r of data || []) {
      const day = new Date(r.data_hora).toISOString().slice(0, 10);
      byDay[day] ||= { glyVals: [], cho: 0, ins: 0 };
      if (Number.isFinite(r.glicemia)) byDay[day].glyVals.push(Number(r.glicemia));
      byDay[day].cho += Number(r.cho_total_g || 0);
      byDay[day].ins += Number(r.dose_rapida_total || 0);
    }
    const gly = [], cho = [], ins = [];
    for (const day of Object.keys(byDay).sort()) {
      const b = byDay[day];
      const mean = b.glyVals.length ? b.glyVals.reduce((a, v) => a + v, 0) / b.glyVals.length : 0;
      gly.push({ x: day, y: mean });
      cho.push({ x: day, y: b.cho });
      ins.push({ x: day, y: b.ins });
    }
    res.json({ ok: true, series: { gly, cho, ins } });
  } catch (e) {
    console.error("[GET /api/refeicoes/serie]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/refeicoes/:id", async (req, res) => {
  try {
    const supabase = supabaseFromReq(req);
    const { id } = req.params;
    const { userId } = req.query;
    if (!id || !userId) {
      return res.status(400).json({ ok: false, error: "id e userId são obrigatórios" });
    }

    const { data: row, error: eSel } = await supabase
      .from("refeicoes")
      .select("id,user_id")
      .eq("id", id)
      .single();
    if (eSel && eSel.code !== "PGRST116") throw eSel;
    if (!row) return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    if ((row.user_id || "").trim() !== (userId || "").trim()) {
      return res.status(403).json({ ok: false, error: "Sem permissão." });
    }

    const { error: eDel } = await supabase.from("refeicoes").delete().eq("id", id);
    if (eDel) throw eDel;
    res.json({ ok: true, deleted: id });
  } catch (e) {
    console.error("[DELETE /api/refeicoes/:id]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===================== SPA fallback ===================== */
// Agora aponta para public/glicocerto/index.html (seu app vive no subcaminho /glicocerto)
// No original estava para public/index.html. :contentReference[oaicite:3]{index=3}
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(__dirname, "public", "glicocerto", "index.html"));
});

/* ======================== Start ======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ GlicoCerto API rodando em http://localhost:${PORT}`);
});