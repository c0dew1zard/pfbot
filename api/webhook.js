import { askGroq } from "../lib/groq.js";
import { getAccts, getTxs, addTxs, setDefault, addAccount, deleteAllTxs, deleteLastTx, deleteTxByDescription, deleteTxById, appendLog, getLogs, clearLogs } from "../lib/db.js";
import { buildReport, detectMonthFilter } from "../lib/report.js";

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID = process.env.ALLOWED_CHAT_ID ? String(process.env.ALLOWED_CHAT_ID) : null;

// ─── Telegram API ─────────────────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[pfbot][ERROR][sendMessage]`, JSON.stringify(data));
    } else {
      console.log(`[pfbot][sendMessage] ok to ${chatId}`);
    }
  } catch (err) {
    console.error(`[pfbot][ERROR][sendMessage_fetch]`, err?.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(from, tag, data) {
  const str = typeof data === "object" ? JSON.stringify(data) : String(data ?? "");
  console.log(`[pfbot][${tag}]`, str);
  appendLog(from, tag, str); // fire-and-forget
}

function logError(from, tag, err) {
  const str = `${err?.message || err}`;
  console.error(`[pfbot][ERROR][${tag}]`, str);
  appendLog(from, `ERR:${tag}`, str); // fire-and-forget
}
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  let body = "";
  try {
    body = await new Promise((resolve, reject) => {
      let d = "";
      req.on("data", chunk => { d += chunk; });
      req.on("end", () => resolve(d));
      req.on("error", reject);
    });
  } catch (err) {
    console.error("[pfbot][ERROR][body_read]", err?.message);
    res.status(500).end();
    return;
  }

  // Always ack Telegram immediately — but keep function alive
  res.status(200).json({ ok: true });

  let update;
  try {
    update = JSON.parse(body);
  } catch {
    return;
  }

  const message = update?.message;
  if (!message?.text) return;

  const chatId  = String(message.chat.id);
  const msgBody = message.text.trim();
  const from    = `tg:${chatId}`; // KV key prefix

  // Auth
  if (ALLOWED_ID && chatId !== ALLOWED_ID) {
    await sendMessage(chatId, "Acesso nao autorizado.");
    return;
  }

  const lower = msgBody.toLowerCase();

  // ── Debug ─────────────────────────────────────────────────────────────────
  if (lower === "debug" || lower === "logs") {
    const logs = await getLogs(from);
    if (!logs.length) {
      await sendMessage(chatId, "Sem logs registados.");
      return;
    }
    const lines = logs.map(l => `${l.ts} [${l.tag}] ${l.data}`).join("\n");
    await sendMessage(chatId, `Ultimos ${logs.length} logs:\n\n\`\`\`\n${lines}\n\`\`\``);
    return;
  }

  if (lower === "debug limpar" || lower === "logs limpar") {
    await clearLogs(from);
    await sendMessage(chatId, "Logs apagados.");
    return;
  }

  log(from, "msg", msgBody);

  // ── Listar ────────────────────────────────────────────────────────────────
  const listKeywords = ["listar", "lista", "listar tudo", "todas as transações", "todas as transacoes"];
  if (listKeywords.some(k => lower.includes(k))) {
    log(from, "cmd", "listar");
    try {
      const txs = await getTxs(from);
      const confirmed = (txs || []).filter(t => !t.scheduled);
      if (!confirmed.length) {
        await sendMessage(chatId, "Nao ha transacoes registadas.");
        return;
      }
      const MAX = 20;
      const recent = [...confirmed].reverse().slice(0, MAX);
      const header = `📋 *Transacoes (${confirmed.length} total — ultimas ${recent.length}):*\n\n`;
      const lines = recent.map(tx => {
        const sign = tx.type === "income" ? "+" : tx.type === "transfer" ? "=" : "-";
        const amt = parseFloat(tx.amount || 0).toFixed(2);
        return `\`#${tx.id || "????"}\` ${tx.date || ""} ${sign}€${amt} ${tx.description || ""} (${tx.account || ""})`;
      });
      const footer = confirmed.length > MAX ? `\n\n_Usa "listar abril" para filtrar por mes._` : "";
      await sendMessage(chatId, header + lines.join("\n") + footer);
    } catch (err) {
      logError(from, "listar", err);
      await sendMessage(chatId, `Erro ao listar: ${err.message}`);
    }
    return;
  }

  // ── Relatório ─────────────────────────────────────────────────────────────
  const reportKeywords = ["resumo","relatorio","relatório","saldo","quanto gastei","quanto entrou","estatisticas","estatísticas"];
  if (reportKeywords.some(k => lower.includes(k))) {
    log(from, "cmd", "report");
    try {
      const [txs, accts] = await Promise.all([getTxs(from), getAccts(from)]);
      const monthFilter = detectMonthFilter(msgBody);
      const report = buildReport(txs || [], accts, monthFilter);
      await sendMessage(chatId, report);
    } catch (err) {
      logError(from, "report", err);
      await sendMessage(chatId, `Erro no relatorio: ${err.message}`);
    }
    return;
  }

  // ── Ajuda ─────────────────────────────────────────────────────────────────
  if (lower === "ajuda" || lower === "help" || lower === "/start" || lower === "comandos") {
    log(from, "cmd", "ajuda");
    await sendMessage(chatId, `💸 *Registar despesa:*
"paguei 50€ de supermercado"
"gastei 480 de renda na Revolut"

💰 *Registar receita:*
"recebi 3000€ de Cliente"

🔄 *Transferencia:*
"transferi 200€ da Revolut para Moey"

📊 *Relatorio:*
"resumo" / "saldo" / "relatorio abril"
"quanto gastei este mes"

🗑 *Apagar:*
"apagar ultima"
"apagar renda"
"apagar #xxxx"
"apagar tudo"

📋 *Listar:*
"listar"

🏦 *Contas:*
"cria conta Wise"
"conta padrao Moey"

🐛 *Debug:*
"debug" / "debug limpar"`);
    return;
  }

  // ── Apagar por ID ─────────────────────────────────────────────────────────
  const idMatch = lower.match(/^apaga(?:r)?\s+#([a-z0-9]{4})$/);
  if (idMatch) {
    log(from, "cmd", `apagar_id:${idMatch[1]}`);
    try {
      const removed = await deleteTxById(from, idMatch[1]);
      const reply = removed
        ? `✓ Removida: ${removed.description} (€${parseFloat(removed.amount).toFixed(2)} — ${removed.date})`
        : `Nenhuma transacao com ID #${idMatch[1]}.`;
      await sendMessage(chatId, reply);
    } catch (err) {
      logError(from, "apagar_id", err);
      await sendMessage(chatId, `Erro ao apagar: ${err.message}`);
    }
    return;
  }

  // ── Apagar tudo ───────────────────────────────────────────────────────────
  if (lower === "apagar tudo" || lower === "apaga tudo") {
    log(from, "cmd", "apagar_tudo");
    try {
      await deleteAllTxs(from);
      await sendMessage(chatId, "✓ Todas as transacoes foram apagadas.");
    } catch (err) {
      logError(from, "apagar_tudo", err);
      await sendMessage(chatId, `Erro ao apagar: ${err.message}`);
    }
    return;
  }

  // ── Apagar última ─────────────────────────────────────────────────────────
  if (["apagar última","apagar ultima","apaga última","apaga ultima"].includes(lower)) {
    log(from, "cmd", "apagar_ultima");
    try {
      const removed = await deleteLastTx(from);
      const reply = removed
        ? `✓ Removida: ${removed.description} (€${parseFloat(removed.amount).toFixed(2)})`
        : "Nao ha transacoes para apagar.";
      await sendMessage(chatId, reply);
    } catch (err) {
      logError(from, "apagar_ultima", err);
      await sendMessage(chatId, `Erro ao apagar: ${err.message}`);
    }
    return;
  }

  // ── Apagar por descrição ──────────────────────────────────────────────────
  const deleteMatch = lower.match(/^apaga(?:r)?\s+(.+)$/);
  if (deleteMatch) {
    const term = deleteMatch[1].trim();
    log(from, "cmd", `apagar_desc:${term}`);
    try {
      const removed = await deleteTxByDescription(from, term);
      const reply = removed
        ? `✓ Removida: ${removed.description} (€${parseFloat(removed.amount).toFixed(2)} — ${removed.date})`
        : `Nenhuma transacao com "${term}".`;
      await sendMessage(chatId, reply);
    } catch (err) {
      logError(from, "apagar_desc", err);
      await sendMessage(chatId, `Erro ao apagar: ${err.message}`);
    }
    return;
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  log(from, "cmd", "groq");
  try {
    const accts = await getAccts(from);
    const parsed = await askGroq(msgBody, accts);
    log(from, "groq_parsed", parsed);

    let replyText = "";

    if (parsed.setDefault) {
      const ok = await setDefault(from, parsed.setDefault.trim());
      replyText = ok
        ? (parsed.reply || `✓ Conta padrao: ${parsed.setDefault}`)
        : `Conta "${parsed.setDefault}" nao existe.`;

    } else if (parsed.newAccount) {
      const name = parsed.newAccount.trim();
      const ok = await addAccount(from, name);
      replyText = ok
        ? (parsed.reply || `✓ Conta ${name} criada!`)
        : `A conta "${name}" ja existe.`;

    } else if (parsed.report) {
      const txs = await getTxs(from);
      const monthFilter = detectMonthFilter(msgBody);
      replyText = buildReport(txs || [], accts, monthFilter);

    } else if (parsed.transactions?.length) {
      log(from, "groq_txs", parsed.transactions.map(t => t.description));
      await addTxs(from, parsed.transactions);
      const count = parsed.transactions.length;
      const base = parsed.reply || `✓ ${count} transacao${count>1?"s":""} registada${count>1?"s":""}`;
      const lines = parsed.transactions.map(tx => {
        const sign = tx.type==="income" ? "+" : tx.type==="transfer" ? "=" : "-";
        return `  ${sign}€${Math.abs(parseFloat(tx.amount||0)).toFixed(2)} ${tx.description}`;
      });
      replyText = `${base}\n${lines.join("\n")}`;

    } else {
      replyText = parsed.reply || "Nao percebi, reformula?";
    }

    await sendMessage(chatId, replyText);

  } catch (err) {
    logError(from, "groq", err);
    await sendMessage(chatId, `Erro interno: ${err.message}`);
  }
}

export const config = {
  api: { bodyParser: false },
};
