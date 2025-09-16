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
function systemPrompt(cfg) {
  const icr     = Number(cfg?.icr || cfg?.insulina_cho || 10);     // g CHO por 1U
  const isf     = Number(cfg?.isf || cfg?.glicose_insulina || 50); // mg/dL por 1U
  const target  = Number(cfg?.target || 100);                      // mg/dL
  const strat   = (cfg?.pg_strategy || "regular_now").trim();      // "regular_now" ou "split_rapid"
  const pgPct   = Math.max(0, Math.min(100, Number(cfg?.pg_percent ?? 100))); // %
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
  • pg_percent (% das kcal de proteína+gordura a considerar): ${pgPct}%
  Regras para proteína+gordura:
  - Calcule energia de proteína e gordura: kcal_pg = proteina_total_g*4 + gordura_total_g*9.
  - Calcule equivalente CHO: pg_cho_equiv_g = round( (kcal_pg * (${pgPct}/100)) / 10 , 1 ).
  - Se ${strat} == "regular_now": mostre dose com Insulina Regular = pg_cho_equiv_g ÷ ${icr}.
  - Se ${strat} == "split_rapid": não usar Regular; informe dose equivalente a proteina e gorduras separada da dose de cho (informe para aplicar de 2–3h depois da refeição), mas mantenha o valor de pg_cho_equiv_g no JSON.

 
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
          <tr><th>Alimento</th><th>Quantidade</th><th>CHO estimado (SBD)</th><th>kcal aprox</th><th>Proteína</th><th>Gordura</th></tr>
        </thead>
        <tbody>
          <!-- Uma linha por item identificado -->
          <!-- Exemplo:
          <tr><td>Arroz branco</td><td>100g</td><td>28g</td><td>~130 kcal</td><td>70g</td><td>18g</td></tr>
          -->
        </tbody>
      </table>
    </div>
    <h3>📊 Totais</h3>
    <ul>
      <!-- Escreva a soma mostrando a conta -->
      <li><b>Carboidratos:</b>  a + b + c = <b>XX g CHO</b></li>
      <li><b>Proteínas/gorduras:</b>  descrição sucinta (ex.: "bife + óleo da preparação") ≈ <b>YY kcal</b></li>
    </ul>

    <h3>💉 Insulina</h3>
    <ul>
      <li><b>${rapid} (carboidrato):</b> CHO_totais ÷ ${icr} = X,U ⇒ <b>YU</b></li>
      <li><b>Correção (glicemia G):</b> (G – ${target}) ÷ ${isf} = Z,U ⇒ <b>WU</b></li>
      <!-- Se ${strat} == "regular_now", calcule e mostre a linha abaixo; caso contrário, escreva em itálico que não será aplicada agora -->
      <li><b>Insulina R (proteína/gordura):</b> pg_cho_equiv_g ÷ ${icr} = P,U ⇒ <b>QU</b></li>
      <li><b>Total bolus:</b>  ${rapid}(YU) + ${strat==="regular_now" ? "Regular(QU) = <b>TU</b>" : "Regular(não aplicável agora) = <b>YU</b>"} </li>
    </ul>

    <h3>✅ Resumo da dose</h3>
    <ul>
      <li><b>${rapid}:</b> YU</li>
      <li><b>${rapid} + Correção:</b> YU + WU = <b>TU</b></li>
      ${strat === "regular_now" ? "<li><b>Insulina R:</b> QU</li>" : "<li><b>Insulina ${rapid} em 2 - 3 horas:</b> QU</li>"}
      <li><b>Total bolus:</b> TU</li>
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

  const kcal = protG*4 + gordG*9;
  const choEq = (kcal * (percent||1)) / 10;  // 10 kcal = 1 g CHO-equivalente
  return { protG, gordG, choEq };
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
      const percent = Math.max(0, Math.min(100, Number(cfg?.pg_percent ?? 100))) / 100;
      if (!(pg_cho_equiv_g > 0)) {
        const { choEq } = computePgFromHtml(detalhes_html, percent);
        pg_cho_equiv_g = choEq;
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
      const percent = Math.max(0, Math.min(100, Number(cfg?.pg_percent ?? 100))) / 100;
      if (!(pg_cho_equiv_g > 0)) {
        const { choEq } = computePgFromHtml(detalhes_html, percent);
        pg_cho_equiv_g = choEq;
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