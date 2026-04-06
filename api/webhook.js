import { askGroq } from "../lib/groq.js";
import { getAccts, getTxs, addTxs, setDefault, addAccount, deleteAllTxs, deleteLastTx, deleteTxByDescription, deleteTxById, appendLog, getLogs, clearLogs } from "../lib/db.js";
import { buildReport, detectMonthFilter } from "../lib/report.js";

// ─── Logger — guarda no KV, visível via comando "debug" no WhatsApp ──────────
async function log(from, tag, data) {
  const str = typeof data === "object" ? JSON.stringify(data) : String(data ?? "");
  console.log(`[pfbot][${tag}]`, str); // ainda aparece nos logs do Vercel se disponíveis
  await appendLog(from, tag, str);
}

async function logError(from, tag, err) {
  const str = `${err?.message || err} | ${err?.stack?.split("\n")[1]?.trim() || ""}`;
  console.error(`[pfbot][ERROR][${tag}]`, str);
  await appendLog(from, `ERR:${tag}`, str);
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
  if (req.method !== "POST") {
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
  } catch (err) {
    console.error("[pfbot][ERROR][body_read]", err?.message);
    res.status(500).end("Body read error");
    return;
  }

  const params  = parseBody(raw);
  const from    = params.From || "";
  const msgBody = (params.Body || "").trim();

  if (process.env.ALLOWED_NUMBER && from !== process.env.ALLOWED_NUMBER) {
    await appendLog(from, "auth_fail", from);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Acesso nao autorizado."));
    return;
  }

  if (!msgBody) {
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Ola! Diz-me o que gastaste ou recebeste."));
    return;
  }

  const lower = msgBody.toLowerCase();
  await log(from, "msg", msgBody);

  // ── Debug ─────────────────────────────────────────────────────────────────
  if (lower === "debug" || lower === "logs") {
    const logs = await getLogs(from);
    if (!logs.length) {
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply("Sem logs registados."));
      return;
    }
    const lines = logs.map(l => `${l.ts} [${l.tag}] ${l.data}`).join("\n");
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(`Ultimos ${logs.length} logs:\n\n${lines}`));
    return;
  }

  if (lower === "debug limpar" || lower === "logs limpar") {
    await clearLogs(from);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Logs apagados."));
    return;
  }

  // ── Listar ────────────────────────────────────────────────────────────────
  const listKeywords = ["listar", "lista", "listar tudo", "todas as transações", "todas as transacoes"];
  if (listKeywords.some(k => lower.includes(k))) {
    await log(from, "cmd", "listar");
    try {
      const txs = await getTxs(from);
      await log(from, "listar_count", (txs || []).length);
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
      await logError(from, "listar", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao listar: ${err.message}`));
    }
    return;
  }

  // ── Relatório ─────────────────────────────────────────────────────────────
  const reportKeywords = ["resumo","relatorio","relatório","saldo","quanto gastei","quanto entrou","estatisticas","estatísticas"];
  if (reportKeywords.some(k => lower.includes(k))) {
    await log(from, "cmd", "report");
    try {
      const [txs, accts] = await Promise.all([getTxs(from), getAccts(from)]);
      await log(from, "report_data", { txs: (txs||[]).length, accts: Object.keys(accts||{}) });
      const monthFilter = detectMonthFilter(msgBody);
      await log(from, "report_filter", monthFilter);
      const report = buildReport(txs || [], accts, monthFilter);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(report));
    } catch (err) {
      await logError(from, "report", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro no relatorio: ${err.message}`));
    }
    return;
  }

  // ── Ajuda ─────────────────────────────────────────────────────────────────
  if (lower === "ajuda" || lower === "help" || lower === "comandos") {
    await log(from, "cmd", "ajuda");
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
"conta padrao Moey"

Debug:
"debug" - ver ultimos logs
"debug limpar" - apagar logs`;
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(help));
    return;
  }

  // ── Apagar por ID ─────────────────────────────────────────────────────────
  const idMatch = lower.match(/^apaga(?:r)?\s+#([a-z0-9]{4})$/);
  if (idMatch) {
    await log(from, "cmd", `apagar_id:${idMatch[1]}`);
    try {
      const removed = await deleteTxById(from, idMatch[1]);
      await log(from, "apagar_id_result", removed ? removed.description : "not_found");
      const reply = removed
        ? `Removida: ${removed.description} (EUR${parseFloat(removed.amount).toFixed(2)} - ${removed.date})`
        : `Nenhuma transacao encontrada com ID #${idMatch[1]}.`;
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(reply));
    } catch (err) {
      await logError(from, "apagar_id", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Apagar tudo ───────────────────────────────────────────────────────────
  if (lower === "apagar tudo" || lower === "apaga tudo") {
    await log(from, "cmd", "apagar_tudo");
    try {
      await deleteAllTxs(from);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply("Todas as transacoes foram apagadas."));
    } catch (err) {
      await logError(from, "apagar_tudo", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Apagar última ─────────────────────────────────────────────────────────
  if (["apagar última","apagar ultima","apaga última","apaga ultima"].includes(lower)) {
    await log(from, "cmd", "apagar_ultima");
    try {
      const removed = await deleteLastTx(from);
      await log(from, "apagar_ultima_result", removed ? removed.description : "empty");
      const reply = removed
        ? `Removida: ${removed.description} (EUR${parseFloat(removed.amount).toFixed(2)})`
        : "Nao ha transacoes para apagar.";
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(reply));
    } catch (err) {
      await logError(from, "apagar_ultima", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Apagar por descrição ──────────────────────────────────────────────────
  const deleteMatch = lower.match(/^apaga(?:r)?\s+(.+)$/);
  if (deleteMatch) {
    const term = deleteMatch[1].trim();
    await log(from, "cmd", `apagar_desc:${term}`);
    try {
      const removed = await deleteTxByDescription(from, term);
      await log(from, "apagar_desc_result", removed ? removed.description : "not_found");
      const reply = removed
        ? `Removida: ${removed.description} (EUR${parseFloat(removed.amount).toFixed(2)} - ${removed.date})`
        : `Nenhuma transacao com "${term}".`;
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(reply));
    } catch (err) {
      await logError(from, "apagar_desc", err);
      res.setHeader("Content-Type", "text/xml");
      res.status(200).send(twimlReply(`Erro ao apagar: ${err.message}`));
    }
    return;
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  await log(from, "cmd", "groq");
  try {
    const accts = await getAccts(from);
    await log(from, "groq_accts", Object.keys(accts || {}));

    const parsed = await askGroq(msgBody, accts);
    await log(from, "groq_parsed", parsed);

    let replyText = "";

    if (parsed.setDefault) {
      const ok = await setDefault(from, parsed.setDefault.trim());
      await log(from, "set_default", { name: parsed.setDefault, ok });
      replyText = ok
        ? (parsed.reply || `Conta padrao: ${parsed.setDefault}`)
        : `Conta "${parsed.setDefault}" nao existe.`;

    } else if (parsed.newAccount) {
      const name = parsed.newAccount.trim();
      const ok = await addAccount(from, name);
      await log(from, "new_account", { name, ok });
      replyText = ok
        ? (parsed.reply || `Conta ${name} criada!`)
        : `A conta "${name}" ja existe.`;

    } else if (parsed.report) {
      const txs = await getTxs(from);
      const monthFilter = detectMonthFilter(msgBody);
      await log(from, "groq_report", { monthFilter, txs: (txs||[]).length });
      replyText = buildReport(txs || [], accts, monthFilter);

    } else if (parsed.transactions?.length) {
      await log(from, "groq_txs", parsed.transactions.map(t => t.description));
      await addTxs(from, parsed.transactions);
      const count = parsed.transactions.length;
      const base = parsed.reply || `${count} transacao${count>1?"s":""} registada${count>1?"s":""}`;
      const lines = parsed.transactions.map(tx => {
        const sign = tx.type==="income" ? "+" : tx.type==="transfer" ? "=" : "-";
        return `  ${sign}EUR${Math.abs(parseFloat(tx.amount||0)).toFixed(2)} ${tx.description}`;
      });
      replyText = `${base}\n${lines.join("\n")}`;

    } else {
      await log(from, "groq_fallback", parsed.reply);
      replyText = parsed.reply || "Nao percebi, reformula?";
    }

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(replyText));

  } catch (err) {
    await logError(from, "groq", err);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(`Erro interno: ${err.message}`));
  }
}

export const config = {
  api: { bodyParser: false },
};
