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
  ? new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    project: process.env.OPENAI_PROJECT || "proj_fDaZI981pUGD9Ua7gmNRn83o",
  })
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
    const icr    = Number(cfg?.icr || cfg?.insulina_cho || 10);     // g CHO por 1U
    const isf    = Number(cfg?.isf || cfg?.glicose_insulina || 50); // mg/dL por 1U
    const target = Number(cfg?.target || 100);                      // mg/dL
    const strat  = String(cfg?.pg_strategy || "regular_now").trim(); // "regular_now" | "split_rapid"
    const pgPct  = Math.max(0, Math.min(100, Number(cfg?.pct_cal_pf ?? 100))); // % proteína (kcal) do cadastro
    const rapid  = String(cfg?.insulina_rapida || "Fiasp");

    return `
  Você é um assistente especializado em cálculo de doses de insulina para Diabetes Tipo 1, seguindo rigorosamente a SBD (Sociedade Brasileira de Diabetes).
  Sua resposta deve ser **somente HTML** (sem Markdown e sem cercas de código), obedecendo ao formato abaixo, com números consistentes entre si.

  PARÂMETROS DO PACIENTE (use nas contas; não precisa exibir):
  - ICR (g/1U): ${icr}
  - ISF (mg/dL/1U): ${isf}
  - Glicemia alvo: ${target} mg/dL
  - Estratégia proteína+gordura: ${strat}  (regular_now = Regular agora; split_rapid = ultrarrápida em 2–3h)
  - Percentual de proteína a considerar (kcal): ${pgPct}%
  - Insulina ultrarrápida de refeição: ${rapid}

  REGRAS SBD — SEMPRE SIGA (nunca use fórmulas alternativas):
  1) Carboidratos (CHO):
    - Some todos os carboidratos (g) dos itens da refeição.
    - Dose por CHO = CHO_totais ÷ ICR.
  2) Correção de glicemia:
    - Se glicemia_atual > alvo: (glicemia_atual – alvo) ÷ ISF; caso contrário, 0U.
  3) Proteína + Gordura:
    - Proteína_total_g → kcalP = proteína_total_g × 4.
    - Gordura_total_g  → kcalG = gordura_total_g × 9.
    - Aplique ${pgPct}% sobre kcalP (proteína) e 10% sobre kcalG (gordura).
    - kcal_total_considerada = (kcalP × ${pgPct}%) + (kcalG × 10%).
    - CHO equivalente (pg_cho_equiv_g) = kcal_total_considerada ÷ 10.  **Nunca use ÷4 aqui.**
    - Dose de proteína+gordura = pg_cho_equiv_g ÷ ICR.
  4) Arredondamento:
    - Doses finais sempre arredondadas para **inteiro** (≥ 0,5 arredonda para cima).
  5) Apresentação:
    - Use exatamente os blocos e a ordem descritos abaixo.
    - Em **📊 Totais**, use **apenas dois itens**: (1) Carboidratos e (2) Proteínas + Gorduras no formato detalhado.
    - Não inclua outros <li> em Totais (não liste “Proteínas:” sozinho, “Gorduras:” sozinho, nem “Proteínas + Gorduras (equivalente CHO)” extra).
    - Use “⇒” para indicar arredondamentos quando útil (ex.: 2,3U ⇒ 2U).

  ========================
  FORMATO OBRIGATÓRIO (HTML)
  ========================

  <div class="details-clean">
    <h3>🍽️ Refeição informada</h3>
    <div class="table-wrap">
      <table class="gc-table">
        <thead>
          <tr>
            <th>Alimento</th>
            <th>Quantidade</th>
            <th>CHO</th>
            <th>kcal aprox</th>
            <th>Proteína</th>
            <th>Gordura</th>
          </tr>
        </thead>
        <tbody>
          <!-- Uma linha por item identificado -->
          <!-- Exemplo:
          <tr>
            <td>Arroz branco</td><td>100 g</td><td>28 g</td><td>~130 kcal</td><td>2,5 g</td><td>0,3 g</td>
          </tr>
          -->
        </tbody>
      </table>
    </div>

    <h3>📊 Totais</h3>
    <ul>
      <li><b>Carboidratos:</b> a + b + c = <b>XX g CHO</b></li>
      <li>
        <b>Proteínas + Gorduras:</b><br>
        Proteína: P1 + P2 + ... = YY g ×4 = KCAL_P × ${pgPct}% = KCAL_P% kcal<br>
        Gordura: G1 + G2 + ... = ZZ g ×9 = KCAL_G × 10% = KCAL_G10 kcal<br>
        Carboidratos (p+g) = KCAL_P% + KCAL_G10 = KCAL_TOTAL kcal ÷10 = <b>EQ_PG g CHO</b>
      </li>
    </ul>

    <h3>💉 Insulina</h3>
    <ul>
      <li><b>${rapid} (cho):</b> CHO_totais ÷ ${icr} = X,U ⇒ <b>YU</b></li>
      <li><b>Correção (glicemia):</b> máx(0, (Glicemia – ${target}) ÷ ${isf}) = Z,U ⇒ <b>WU</b></li>
      ${strat === "regular_now"
        ? `<li><b>Insulina R (proteína/gordura):</b> EQ_PG ÷ ${icr} = P,U ⇒ <b>QU</b></li>`
        : `<li><i>Proteína/gordura será aplicada com insulina ${rapid} em 2–3 horas:</i> EQ_PG ÷ ${icr} = P,U ⇒ <b>QU</b></li>`
      }
      <li><b>Total bolus:</b> ${strat === "regular_now" ? `${rapid}(YU+WU) + Regular(QU)` : `${rapid}(YU+WU) + ${rapid}(QU em 2–3h)`} = <b>TU</b></li>
    </ul>

    <h3>✅ Resumo da dose</h3>
    <ul>
      <li><b>${rapid}:</b> YU + WU = <b>SU</b></li>
      ${strat === "regular_now"
        ? `<li><b>Insulina R:</b> QU</li>`
        : `<li><b>${rapid} (p/g em 2–3h):</b> QU</li>`
      }
      <li><b>Total bolus:</b> ${strat === "regular_now" ? `SU + QU = <b>TU</b>` : `SU + QU = <b>TU</b>`}</li>
      <li><b>Calorias da refeição:</b> ≈ KK kcal</li>
    </ul>

    <!-- BLOCO JSON OBRIGATÓRIO -->
    <pre>{
      "carbo_g": XX,
      "carbo_totais_g": XX,
      "fibras_g": 0,
      "poliois_g": 0,
      "pg_cho_equiv_g": EQ_PG,
      "kcal_total": KK,
      "resumo": "descrição curta: ex. 100 g arroz, 40 g feijão, 1 bife"
    }</pre>
  </div>

  REGRAS DE RENDERIZAÇÃO
  - Apenas HTML. Não usar Markdown. Não repetir enunciados/instruções.
  - Mostre 1 casa decimal quando útil nas contas intermediárias; doses finais sempre em inteiros.
  - Use “g” para gramas, “kcal” para energia e “CHO” para carboidratos.
  - Se não conseguir identificar algum item, estime de forma conservadora e sinalize com “~”.

  VALIDAÇÃO (consistência obrigatória)
  - Os valores de “CHO_totais”, “EQ_PG” e as doses (YU, WU, QU, SU, TU) devem ser numericamente coerentes com a tabela e com as fórmulas SBD acima.
  - “EQ_PG” deve SEMPRE ser calculado como: (kcalP × ${pgPct}% + kcalG × 10%) ÷ 10. **Nunca** use ÷4 aqui.
  - “Insulina R (proteína/gordura)” (ou ultrarrápida em 2–3h, se ${strat} = split_rapid) deve SEMPRE ser: EQ_PG ÷ ${icr}, arredondado para inteiro.
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
  const partsP = [], partsG = [];
  const rows = String(html).match(/<tbody>[\s\S]*?<\/tbody>/i);
  if(rows){
    const tr = rows[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for(const r of tr){
      const tds = r.match(/<td[\s\S]*?<\/td>/gi) || [];
      if(tds.length >= 6){
        const protTd = tds[4].replace(/<[^>]+>/g,'').trim();
        const gordTd = tds[5].replace(/<[^>]+>/g,'').trim();
        const p = numBR(protTd); // aceita "7g" ou "7"
        const g = numBR(gordTd);
        if (p){ prot += p; partsP.push(p); }
        if (g){ gord += g; partsG.push(g); }
      }
    }
  }
  return { prot_g: prot, gord_g: gord, partsP, partsG };
}
// Remove os <li> extras ("Proteínas:", "Gorduras:", "Proteínas + Gorduras (equivalente CHO)")

// Remove quaisquer <li> relacionados a Proteínas+Gorduras gerados pela IA
function stripExtraPgLis(html){
  return String(html)
    // remove "Proteínas:" isolado
    .replace(/<li>\s*<b>Prote[ií]nas:\b[\s\S]*?<\/li>\s*/gi, "")
    // remove "Gorduras:" isolado
    .replace(/<li>\s*<b>Gorduras:\b[\s\S]*?<\/li>\s*/gi, "")
    // remove "Proteínas + Gorduras (equivalente CHO): ..."
    .replace(/<li>\s*<b>Prote[ií]nas\s*\+\s*Gorduras\s*\(equivalente\s*CHO\)\s*:[\s\S]*?<\/li>\s*/gi, "")
    // remove QUALQUER bloco "Proteínas + Gorduras:" (com ou sem extra)
    .replace(/<li>\s*<b>Prote[ií]nas\s*\+\s*Gorduras\s*:[\s\S]*?<\/li>\s*/gi, "");
}


// Corrige a linha "Insulina R (proteína/gordura): ..." no bloco Insulina
function patchRegularDose(html, regU){
  let out = String(html);

  // Linha do bloco "💉 Insulina"
  out = out.replace(
    /(<li><b>Insulina R \(prote[ií]na\/gordura\):[^<]*?)\d+(?:[.,]\d+)?U/i,
    `$1${regU}U`
  );

  // Linha no "✅ Resumo da dose"
  out = out.replace(
    /(<li><b>Insulina R:?\s*<\/b>\s*)\d+(?:[.,]\d+)?U/i,
    `$1${regU}U`
  );

  // Caso a estratégia seja rápida depois (split_rapid)
  out = out.replace(
    /(<li><b>Insulina [^<]*?2\s*[–-]\s*3\s*horas:?\s*<\/b>\s*)\d+(?:[.,]\d+)?U/i,
    `$1${regU}U`
  );

  return out;
}

// Mantém o total com "XU + YU = ZU"
function patchTotalBolus(html, rapidName, rapidU, regU){
  const total = rapidU + regU;
  const li = `<li><b>Total bolus:</b> ${rapidU}U + ${regU}U = <b>${total}U</b></li>`;
  return String(html).replace(/<li><b>Total bolus:[\s\S]*?<\/li>/i, li);
}



// Insere/atualiza a linha de “Proteínas/gorduras … → X g CHO” nos Totais

function patchPgTotals(html, prot_g, gord_g, kcalP, kcalG, kcalSumConsiderada, choEq, partsP, partsG, protPct){
  const fmt1 = (n) => Number(n).toFixed(1);

  // monta as somas detalhadas (3 + 40 = 43g; 0,5 + 70 = 70,5g etc.)
  const joinParts = (arr) => arr && arr.length ? arr.map(v => String(v).replace('.', ',')).join(' + ') : '';
  const protSum = partsP?.length ? `${joinParts(partsP)} = ${String(prot_g).replace('.', ',')}g` : `${String(prot_g).replace('.', ',')}g`;
  const gordSum = partsG?.length ? `${joinParts(partsG)} = ${String(gord_g).replace('.', ',')}g` : `${String(gord_g).replace('.', ',')}g`;

  const kcalPpct = (kcalP * (protPct/100));
  const kcalG10  = (kcalG * 0.10);

  // 1) remove tudo que seja P+G pré-existente
  let out = stripExtraPgLis(String(html));

  // 2) monta o ÚNICO bloco
  const bloco = [
    `<li>`,
    `<b>Proteínas + Gorduras:</b><br>`,
    `Proteína: ${protSum} ×4 = ${String(Math.round(kcalP)).replace('.', ',')} kcal × ${protPct}% = ${String(fmt1(kcalPpct)).replace('.', ',')} kcal<br>`,
    `Gordura: ${gordSum} ×9 = ${String(Math.round(kcalG)).replace('.', ',')} kcal × 10% = ${String(fmt1(kcalG10)).replace('.', ',')} kcal<br>`,
    `Carboidratos (p+g) = ${String(fmt1(kcalPpct)).replace('.', ',')} + ${String(fmt1(kcalG10)).replace('.', ',')} = ${String(fmt1(kcalSumConsiderada)).replace('.', ',')} kcal ÷10 = <b>${String(choEq.toFixed(1)).replace('.', ',')} g CHO</b>`,
    `</li>`
  ].join("");

  // 3) insere após o <li> Carboidratos
  if (/<li>\s*<b>Carboidratos:\b[\s\S]*?<\/li>/i.test(out)){
    out = out.replace(/(<li>\s*<b>Carboidratos:\b[\s\S]*?<\/li>)/i, `$1\n${bloco}`);
  } else {
    // fallback: adiciona no fim da <ul> de Totais
    out = out.replace(/(<h3>[^<]*Totais[^<]*<\/h3>\s*<ul[^>]*>)/i, `$1\n${bloco}`);
  }

  return out;
}



// Garante a regra SBD no HTML + JSON <pre> final (usa % do cadastro!)

function enforcePgRule(html, cfg){
  const protPct = Math.max(0, Math.min(100, Number(cfg?.pct_cal_pf ?? 0)));
  const icr     = Number(cfg?.icr || cfg?.insulina_cho || 10);

  // limpa quaisquer blocos de P+G que a IA possa ter inserido
  let out = stripExtraPgLis(String(html));

  // extrai proteína/gordura da tabela
  const { prot_g, gord_g, partsP, partsG } = parseProtGordFromTable(out);

  const kcalP = prot_g * 4;
  const kcalG = gord_g * 9;
  const kcalProtConsiderada = kcalP * (protPct/100);
  const kcalGordConsiderada = kcalG * 0.10;

  const pg_cho_equiv_g = (kcalProtConsiderada + kcalGordConsiderada) / 10;

  // insere o ÚNICO bloco de P+G já corrigido
  out = patchPgTotals(
    out,
    prot_g, gord_g,
    kcalP,  kcalG,
    (kcalProtConsiderada + kcalGordConsiderada),
    pg_cho_equiv_g,
    partsP, partsG,
    protPct
  );

  // atualiza o <pre>{...}
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

  return { html: out, pg_cho_equiv_g, doseRegular: icr>0 ? (pg_cho_equiv_g/icr) : 0, protPct };
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

      // === Força a regra SBD no HTML/JSON (usa % do cadastro e 10% gordura) ===
      const enforced = enforcePgRule(detalhes_html, cfg);
      detalhes_html   = enforced.html;
      if (!(pg_cho_equiv_g > 0)) pg_cho_equiv_g = enforced.pg_cho_equiv_g;

    } else {
      detalhes_html = "<em>Análise automática indisponível.</em>";
    }

      
    const icr    = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf    = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat  = (cfg?.pg_strategy || "regular_now").trim();

    // doses base (numéricos)
    const doseCho = carbo_g / icr;                                   // rápida (CHO)
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);   // rápida (correção)
    const dosePg  = strat === "regular_now" ? pg_cho_equiv_g / icr : 0; // Regular (P+G) agora

    // valores arredondados para exibição
    const rapidName   = String(cfg?.insulina_rapida || "Fiasp");
    const rapidTotalU = r0(doseCho + doseCor);
    const regularU    = r0(dosePg);

    // Corrige o HTML da IA (sempre força o certo)
    detalhes_html = patchRegularDose(detalhes_html, regularU);
    detalhes_html = patchTotalBolus(detalhes_html, rapidName, rapidTotalU, regularU);

    // gravação (se falhar com descrição_model, tentamos sem o HTML)
    const insertPayload = {
      user_id: userId,
      data_hora: new Date().toISOString(),
      tipo: tipo || "outro",
      descricao: refeicao_resumo || String(message || "").trim(),
      glicemia: Number(glicemia),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: rapidTotalU,
      dose_regular_pg: regularU,
      descricao_model: detalhes_html,
    };
    let { error: e1 } = await supabase.from("refeicoes").insert(insertPayload);
    if (e1) {
      const basic = { ...insertPayload };
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
      // === Força a regra SBD no HTML/JSON (usa % do cadastro e 10% gordura) ===
      const enforced = enforcePgRule(detalhes_html, cfg);
      detalhes_html   = enforced.html;
      if (!(pg_cho_equiv_g > 0)) pg_cho_equiv_g = enforced.pg_cho_equiv_g;
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

    const icr    = Number(cfg?.icr || cfg?.insulina_cho || 10);
    const isf    = Number(cfg?.isf || cfg?.glicose_insulina || 50);
    const target = Number(cfg?.target || 100);
    const strat  = (cfg?.pg_strategy || "regular_now").trim();

    const doseCho = carbo_g / icr;
    const doseCor = Math.max(0, (Number(glicemia) - target) / isf);
    const dosePg  = strat === "regular_now" ? pg_cho_equiv_g / icr : 0;

    const rapidName   = String(cfg?.insulina_rapida || "Fiasp");
    const rapidTotalU = r0(doseCho + doseCor);
    const regularU    = r0(dosePg);

    // aplicar patches no HTML
    detalhes_html = patchRegularDose(detalhes_html, regularU);
    detalhes_html = patchTotalBolus(detalhes_html, rapidName, rapidTotalU, regularU);

    const insertPayload = {
      user_id: userId,
      data_hora: new Date().toISOString(),
      tipo: tipo || "outro",
      descricao: refeicao_resumo || String(message || "").trim(),
      glicemia: Number(glicemia),
      cho_total_g: Number(carbo_g),
      pg_cho_equiv_g: Number(pg_cho_equiv_g),
      dose_rapida_total: rapidTotalU,
      dose_regular_pg: regularU,
      descricao_model: detalhes_html,
      foto_url,
    };
    let { error: e1 } = await supabase.from("refeicoes").insert(insertPayload);
    if (e1) {
      const basic = { ...insertPayload };          // <<< corrigido
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