import { askGroq } from "../lib/groq.js";
import { getAccts, setAccts, getTxs, addTxs, setDefault, addAccount, deleteAllTxs, deleteLastTx, deleteTxByDescription, deleteTxById } from "../lib/db.js";
import { buildReport, detectMonthFilter } from "../lib/report.js";

// ─── Debug logger ────────────────────────────────────────────────────────────
// Enable by adding DEBUG=true in Vercel Environment Variables
const DEBUG = process.env.DEBUG === "true";

function log(tag, data) {
  if (DEBUG) {
    console.log(`[pfbot][${tag}]`, typeof data === "object" ? JSON.stringify(data) : data);
  }
}

function logError(tag, err) {
  // Always log errors regardless of DEBUG flag
  console.error(`[pfbot][ERROR][${tag}]`, err?.message || err, err?.stack || "");
}
// ─────────────────────────────────────────────────────────────────────────────

function parseBody(raw) {
  const params = {};
  for (const pair of raw.split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
  }
  return params;
}

function twimlReply(text) {
  const safe = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${safe}</Message>
</Response>`;
}

export default async function handler(req, res) {
  log("request", { method: req.method, url: req.url });

  if (req.method !== "POST") {
    log("reject", "not POST");
    res.status(405).end("Method Not Allowed");
    return;
  }

  let raw = "";
  try {
    raw = await new Promise((resolve, reject) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
    log("body_raw", raw.slice(0, 300));
  } catch (err) {
    logError("body_read", err);
    res.status(500).end("Body read error");
    return;
  }

  const params = parseBody(raw);
  const from    = params.From || "";
  const msgBody = (params.Body || "").trim();

  log("parsed", { from, msgBody });

  if (process.env.ALLOWED_NUMBER && from !== process.env.ALLOWED_NUMBER) {
    log("auth_fail", { from, expected: process.env.ALLOWED_NUMBER });
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Acesso nao autorizado."));
    return;
  }

  if (!msgBody) {
    log("empty_msg", "no body");
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Ola! Diz-me o que gastaste ou recebeste."));
    return;
  }

  const lower = msgBody.toLowerCase();
  log("route", lower);

  // ── Listar ────────────────────────────────────────────────────────────────
  const listKeywords = ["listar", "lista", "listar tudo", "todas as transações", "todas as transacoes"];
  if (listKeywords.some(k => lower.includes(k))) {
    log("cmd", "listar");
    try {
      const txs = await getTxs(from);
      log("listar_count", (txs || []).length);
      const confirmed = (txs || []).filter(t => !t.scheduled);
      if (!confirmed.length) {
        res.setHeader("Content-Type", "text/xml");
        res.status(200).send(twimlReply("Nao ha transacoes registadas."));
        return;
      }
      const MAX = 20;
      const recent = [...confirmed].reverse().slice(0, MAX);
      const header = `Transacoes (${confirmed.length} total - ultimas ${recent.length}):\n\n`;
      const lines = recent.map(tx => {
        const sign = tx.type === "income" ? "+" : tx.type === "transfer" ? "=" : "-";
        const amt = parseFloat(tx.amount || 0).toFixed(2);
        return `#${tx.id || "????"} ${tx.date || ""} ${sign}EUR${amt} ${tx.description || ""} (${tx.account || ""})`;
      });
      const footer = confirmed.length > MAX ? `\n\nUsa "listar abril" para filtrar por mes.` : "";
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(header + lines.join("\n") + footer));
    } catch (err) {
      logError("listar", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao listar: ${err.message}`));
    }
    return;
  }

  // ── Relatório ─────────────────────────────────────────────────────────────
  const reportKeywords = ["resumo","relatorio","relatório","saldo","quanto gastei","quanto entrou","estatisticas","estatísticas"];
  if (reportKeywords.some(k => lower.includes(k))) {
    log("cmd", "report");
    try {
      const [txs, accts] = await Promise.all([getTxs(from), getAccts(from)]);
      log("report_data", { txs_count: (txs||[]).length, accts: Object.keys(accts||{}) });
      const monthFilter = detectMonthFilter(msgBody);
      log("report_filter", monthFilter);
      const report = buildReport(txs || [], accts, monthFilter);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(report));
    } catch (err) {
      logError("report", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro no relatorio: ${err.message}`));
    }
    return;
  }

  // ── Ajuda ─────────────────────────────────────────────────────────────────
  if (lower === "ajuda" || lower === "help" || lower === "comandos") {
    log("cmd", "ajuda");
    const help = `Registar despesa:
"paguei 50EUR de supermercado"
"gastei 480 de renda na Revolut"

Registar receita:
"recebi 3000EUR de Cliente"

Transferencia:
"transferi 200EUR da Revolut para Moey"

Relatorio:
"resumo" / "saldo" / "relatorio abril"
"quanto gastei este mes"

Apagar:
"apagar ultima" - remove a ultima transacao
"apagar renda" - remove por descricao
"apagar #xxxx" - remove por ID
"apagar tudo" - apaga tudo

Contas:
"cria conta Wise"
"conta padrao Moey"`;
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(help));
    return;
  }

  // ── Apagar por ID ─────────────────────────────────────────────────────────
  const idMatch = lower.match(/^apaga(?:r)?\s+#([a-z0-9]{4})$/);
  if (idMatch) {
    log("cmd", { apagar_id: idMatch[1] });
    try {
      const removed = await deleteTxById(from, idMatch[1]);
      log("apagar_id_result", removed);
      const reply = removed
        ? `Removida: ${removed.description} (EUR${parseFloat(removed.amount).toFixed(2)} - ${removed.date})`
        : `Nenhuma transacao encontrada com ID #${idMatch[1]}.`;
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(reply));
    } catch (err) {
      logError("apagar_id", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Apagar tudo ───────────────────────────────────────────────────────────
  if (lower === "apagar tudo" || lower === "apaga tudo") {
    log("cmd", "apagar_tudo");
    try {
      await deleteAllTxs(from);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply("Todas as transacoes foram apagadas."));
    } catch (err) {
      logError("apagar_tudo", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Apagar última ─────────────────────────────────────────────────────────
  if (["apagar última","apagar ultima","apaga última","apaga ultima"].includes(lower)) {
    log("cmd", "apagar_ultima");
    try {
      const removed = await deleteLastTx(from);
      log("apagar_ultima_result", removed);
      const reply = removed
        ? `Removida: ${removed.description} (EUR${parseFloat(removed.amount).toFixed(2)})`
        : "Nao ha transacoes para apagar.";
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(reply));
    } catch (err) {
      logError("apagar_ultima", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Apagar por descrição ──────────────────────────────────────────────────
  const deleteMatch = lower.match(/^apaga(?:r)?\s+(.+)$/);
  if (deleteMatch) {
    const term = deleteMatch[1].trim();
    log("cmd", { apagar_desc: term });
    try {
      const removed = await deleteTxByDescription(from, term);
      log("apagar_desc_result", removed);
      const reply = removed
        ? `Removida: ${removed.description} (EUR${parseFloat(removed.amount).toFixed(2)} - ${removed.date})`
        : `Nenhuma transacao com "${term}".`;
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(reply));
    } catch (err) {
      logError("apagar_desc", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  log("cmd", "groq");
  try {
    const accts = await getAccts(from);
    log("groq_accts", Object.keys(accts || {}));

    const parsed = await askGroq(msgBody, accts);
    log("groq_parsed", parsed);

    let replyText = "";

    if (parsed.setDefault) {
      const ok = await setDefault(from, parsed.setDefault.trim());
      log("set_default", { name: parsed.setDefault, ok });
      replyText = ok
        ? (parsed.reply || `Conta padrao: ${parsed.setDefault}`)
        : `Conta "${parsed.setDefault}" nao existe.`;

    } else if (parsed.newAccount) {
      const name = parsed.newAccount.trim();
      const ok = await addAccount(from, name);
      log("new_account", { name, ok });
      replyText = ok
        ? (parsed.reply || `Conta ${name} criada!`)
        : `A conta "${name}" ja existe.`;

    } else if (parsed.report) {
      const txs = await getTxs(from);
      const monthFilter = detectMonthFilter(msgBody);
      log("groq_report", { monthFilter, txs_count: (txs||[]).length });
      replyText = buildReport(txs || [], accts, monthFilter);

    } else if (parsed.transactions?.length) {
      log("groq_txs", parsed.transactions);
      await addTxs(from, parsed.transactions);
      const count = parsed.transactions.length;
      const base = parsed.reply || `${count} transacao${count>1?"s":""} registada${count>1?"s":""}`;
      const lines = parsed.transactions.map(tx => {
        const sign = tx.type==="income" ? "+" : tx.type==="transfer" ? "=" : "-";
        return `  ${sign}EUR${Math.abs(parseFloat(tx.amount||0)).toFixed(2)} ${tx.description}`;
      });
      replyText = `${base}\n${lines.join("\n")}`;

    } else {
      log("groq_fallback", parsed);
      replyText = parsed.reply || "Nao percebi, reformula?";
    }

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(replyText));

  } catch (err) {
    logError("groq", err);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(`Erro interno: ${err.message}`));
  }
}

export const config = {
  api: { bodyParser: false },
};
