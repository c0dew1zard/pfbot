import * as XLSX from "xlsx";

function guessCategory(description) {
  const d = (description || "").toLowerCase();
  if (d.includes("uber") || d.includes("bolt") || d.includes("taxi") || d.includes("cp ") || d.includes("comboio") || d.includes("metro") || d.includes("carris")) return "Transportes";
  if (d.includes("continente") || d.includes("pingo doce") || d.includes("lidl") || d.includes("aldi") || d.includes("mercadona") || d.includes("minipreco") || d.includes("minipreço") || d.includes("supermercado") || d.includes("jumbo") || d.includes("intermarche")) return "Alimentação";
  if (d.includes("netflix") || d.includes("spotify") || d.includes("amazon prime") || d.includes("youtube") || d.includes("disney") || d.includes("hbo") || d.includes("apple ")) return "Subscrições";
  if (d.includes("farmacia") || d.includes("farmácia") || d.includes("medico") || d.includes("médico") || d.includes("hospital") || d.includes("clinica") || d.includes("dental")) return "Saúde";
  if (d.includes("coinbase") || d.includes("binance") || d.includes("crypto") || d.includes("revolut digital assets") || d.includes("kraken")) return "Cripto";
  if (d.includes("salary") || d.includes("salario") || d.includes("salário") || d.includes("payroll") || d.includes("vencimento")) return "Rendimento";
  if (d.includes("galp") || d.includes("bp ") || d.includes("repsol") || d.includes("combustivel") || d.includes("combustível")) return "Transportes";
  if (d.includes("zara") || d.includes("h&m") || d.includes("mango") || d.includes("primark")) return "Roupa";
  if (d.includes("renda") || d.includes("condominio") || d.includes("condomínio") || d.includes("eletricidade") || d.includes("seguro")) return "Administrativo";
  return "Outros";
}

function detectTransfer(type, description) {
  const d = (description || "").toLowerCase();
  const desc = description || "";
  if (d.includes("pocket withdrawal")) return { isTransfer: true, toAccount: "Dinheiro" };
  if (d.match(/to pocket eur (.+)/i)) {
    const m = desc.match(/to pocket eur (.+)/i);
    return { isTransfer: true, toAccount: m ? m[1].trim() : "Poupanças" };
  }
  if (d.includes("atm") || d.includes("cash withdrawal")) return { isTransfer: true, toAccount: "Dinheiro" };
  const toMatch = desc.match(/^To (.+)$/i);
  if (toMatch) {
    let name = toMatch[1].trim().replace(/ Ltd$/i, "").replace(/ S\.A\.$/i, "").replace(/ Ireland$/i, "").trim();
    if (name.toLowerCase().includes("coinbase")) name = "Coinbase";
    if (name.toLowerCase().includes("binance")) name = "Binance";
    if (name.toLowerCase().includes("wise")) name = "Wise";
    return { isTransfer: true, toAccount: name };
  }
  return { isTransfer: false };
}

export function parseRevolutExcel(buffer, existingAccts = {}) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].includes("Type") && rows[i].includes("Amount")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error("Formato do ficheiro nao reconhecido.");

  const headers = rows[headerIdx].map(h => (h || "").toString().trim());
  const getCol  = (name) => headers.indexOf(name);
  const COL = {
    type:        getCol("Type"),
    startedDate: getCol("Started Date"),
    description: getCol("Description"),
    amount:      getCol("Amount"),
    currency:    getCol("Currency"),
    state:       getCol("State"),
  };

  const txs     = [];   // ready to import
  const review  = [];   // need user confirmation
  const newAccounts = new Set();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const state       = (row[COL.state] || "").toString().trim().toUpperCase();
    const type        = (row[COL.type] || "").toString().trim();
    const description = (row[COL.description] || "").toString().trim();
    const amountRaw   = row[COL.amount];
    const currency    = (row[COL.currency] || "EUR").toString().trim();
    const dateRaw     = row[COL.startedDate];

    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount === 0) continue;

    // Format date
    let dateStr = "";
    if (dateRaw instanceof Date) {
      dateStr = `${String(dateRaw.getDate()).padStart(2,"0")}/${String(dateRaw.getMonth()+1).padStart(2,"0")}/${dateRaw.getFullYear()}`;
    } else if (typeof dateRaw === "string") {
      const parts = dateRaw.split(" ")[0].split("-");
      if (parts.length === 3) dateStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
    }

    const { isTransfer, toAccount } = detectTransfer(type, description);

    // Build base transaction
    const baseTx = {
      description,
      amount: Math.abs(amount),
      account: "Revolut",
      date: dateStr,
      scheduled: false,
    };

    // PENDING — ask user
    if (state === "PENDING") {
      review.push({
        ...baseTx,
        currency,
        reason: "pending",
        suggestedType: isTransfer ? "transfer" : (amount > 0 ? "income" : "expense"),
        suggestedToAccount: toAccount || null,
        category: guessCategory(description),
      });
      continue;
    }

    // Non-EUR — ask user
    if (currency !== "EUR") {
      review.push({
        ...baseTx,
        currency,
        reason: "non_eur",
        suggestedType: isTransfer ? "transfer" : (amount > 0 ? "income" : "expense"),
        suggestedToAccount: toAccount || null,
        category: guessCategory(description),
      });
      continue;
    }

    // Normal completed EUR transaction
    if (isTransfer && toAccount) {
      if (!existingAccts[toAccount]) newAccounts.add(toAccount);
      txs.push({ ...baseTx, type: "transfer", category: null, toAccount });
    } else {
      txs.push({ ...baseTx, type: amount > 0 ? "income" : "expense", category: guessCategory(description) });
    }
  }

  return { txs, review, newAccounts: [...newAccounts] };
}

// Format a review item as a Telegram message
export function formatReviewItem(item, index, total) {
  const sign = item.amount >= 0 ? "+" : "-";
  const amt  = `${item.currency !== "EUR" ? item.currency : "EUR"}${Math.abs(item.amount).toFixed(2)}`;
  let msg = `*${index}/${total}* — Precisas de confirmar:\n\n`;
  msg += `${item.description}\n`;
  msg += `${sign}${amt} • ${item.date}\n`;
  if (item.reason === "pending") msg += `_(transacao pendente no banco)_\n`;
  if (item.reason === "non_eur") msg += `_(moeda: ${item.currency})_\n`;
  msg += `\n`;
  if (item.suggestedType === "transfer" && item.suggestedToAccount) {
    msg += `(a) Transferencia para *${item.suggestedToAccount}*\n`;
  } else {
    msg += `(a) ${item.amount < 0 ? "Despesa" : "Receita"} (sugerido)\n`;
  }
  msg += `(b) Ignorar\n`;
  msg += `(c) Agendado (pagar mais tarde)`;
  return msg;
}
