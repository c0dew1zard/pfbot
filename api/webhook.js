import { askGroq } from "../lib/groq.js";
import { getAccts, setAccts, getTxs, addTxs, setDefault, addAccount, deleteAllTxs, deleteLastTx, deleteTxByDescription } from "../lib/db.js";
import { buildReport, detectMonthFilter } from "../lib/report.js";

// Parse application/x-www-form-urlencoded (what Twilio sends)
function parseBody(raw) {
  const params = {};
  for (const pair of raw.split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
  }
  return params;
}

function twimlReply(text) {
  // Escape XML special chars
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

  // Read raw body
  const raw = await new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
  });

  const params = parseBody(raw);
  const from    = params.From || "";   // ex: "whatsapp:+351912345678"
  const msgBody = (params.Body || "").trim();

  // Optional: restrict to your number only
  if (process.env.ALLOWED_NUMBER && from !== process.env.ALLOWED_NUMBER) {
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Acesso não autorizado."));
    return;
  }

  if (!msgBody) {
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Olá! Diz-me o que gastaste ou recebeste."));
    return;
  }

  const lower = msgBody.toLowerCase();

  // Detect report request without calling Groq (faster + save tokens)
  const reportKeywords = ["resumo","relatório","relatorio","saldo","quanto gastei","quanto entrou","estatísticas","estatisticas"];
  const isReport = reportKeywords.some(k => lower.includes(k));

  if (isReport) {
    const [txs, accts] = await Promise.all([getTxs(from), getAccts(from)]);
    const monthFilter  = detectMonthFilter(msgBody);
    const report       = buildReport(txs, accts, monthFilter);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(report));
    return;
  }

  // Help command
  if (lower === "ajuda" || lower === "help" || lower === "comandos") {
    const help = `💸 *Registar despesa:*
"paguei 50€ de supermercado"
"gastei 480 de renda na Revolut"

💰 *Registar receita:*
"recebi 3000€ de Cliente"

🔄 *Transferência:*
"transferi 200€ da Revolut para Moey"

📊 *Relatório:*
"resumo" / "saldo" / "relatório abril"
"quanto gastei este mês"

🗑️ *Apagar:*
"apagar última" — remove a última transação
"apagar renda" — remove por descrição
"apagar tudo" — apaga todas as transações

🏦 *Contas:*
"cria conta Wise"
"conta padrão Moey"`;
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(help));
    return;
  }

  // Apagar tudo
  if (lower === "apagar tudo" || lower === "apaga tudo") {
    await deleteAllTxs(from);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("✓ Todas as transações foram apagadas."));
    return;
  }

  // Apagar última
  if (lower === "apagar última" || lower === "apagar ultima" || lower === "apaga última" || lower === "apaga ultima") {
    const removed = await deleteLastTx(from);
    const reply = removed
      ? `✓ Removida: ${removed.description} (€${removed.amount.toFixed(2)})`
      : "Não há transações para apagar.";
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(reply));
    return;
  }

  // Apagar por descrição: "apagar renda" / "apaga netflix"
  const deleteMatch = lower.match(/^apaga(?:r)?\s+(.+)$/);
  if (deleteMatch) {
    const term = deleteMatch[1].trim();
    // Não confundir com "apagar tudo" / "apagar última" já tratados acima
    const removed = await deleteTxByDescription(from, term);
    const reply = removed
      ? `✓ Removida: ${removed.description} (€${removed.amount.toFixed(2)} — ${removed.date})`
      : `Nenhuma transação encontrada com "${term}".`;
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(reply));
    return;
  }

  // Call Groq for everything else
  try {
    const accts  = await getAccts(from);
    const parsed = await askGroq(msgBody, accts);

    let replyText = "";

    if (parsed.setDefault) {
      const ok = await setDefault(from, parsed.setDefault.trim());
      replyText = ok
        ? (parsed.reply || `✓ Conta padrão: *${parsed.setDefault}*`)
        : `Conta "${parsed.setDefault}" não existe.`;

    } else if (parsed.newAccount) {
      const name = parsed.newAccount.trim();
      const ok   = await addAccount(from, name);
      replyText  = ok
        ? (parsed.reply || `✓ Conta *${name}* criada!`)
        : `A conta "${name}" já existe.`;

    } else if (parsed.report) {
      const txs  = await getTxs(from);
      const monthFilter = detectMonthFilter(msgBody);
      replyText  = buildReport(txs, accts, monthFilter);

    } else if (parsed.transactions?.length) {
      await addTxs(from, parsed.transactions);
      const count = parsed.transactions.length;
      const base  = parsed.reply || `✓ ${count} transação${count>1?"s":""} registada${count>1?"s":""}`;

      // Append quick summary of what was recorded
      const lines = parsed.transactions.map(tx => {
        const sign = tx.type==="income" ? "+" : tx.type==="transfer" ? "⇄" : "-";
        return `  ${sign}€${Math.abs(tx.amount).toFixed(2)} ${tx.description}`;
      });
      replyText = `${base}\n${lines.join("\n")}`;

    } else {
      replyText = parsed.reply || "Não percebi, reformula?";
    }

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply(replyText));

  } catch (err) {
    console.error("Webhook error:", err);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twimlReply("Erro interno, tenta outra vez."));
  }
}

export const config = {
  api: { bodyParser: false },
};
