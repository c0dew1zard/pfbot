// Parses a Revolut Excel statement and returns transactions
// compatible with the pfbot format.
// Requires: xlsx npm package

import * as XLSX from "xlsx";

// Revolut transaction types to ignore (internal movements)
const IGNORE_DESCRIPTIONS = [
  "pocket withdrawal",
  "to pocket",
  "from pocket",
];

// Map Revolut Type to pfbot category
function guessCategory(type, description) {
  const d = (description || "").toLowerCase();
  if (d.includes("uber") || d.includes("bolt") || d.includes("taxi") || d.includes("cp ") || d.includes("comboio")) return "Transportes";
  if (d.includes("continente") || d.includes("pingo doce") || d.includes("lidl") || d.includes("aldi") || d.includes("mercadona") || d.includes("supermercado") || d.includes("minipreco") || d.includes("minipreço")) return "Alimentação";
  if (d.includes("netflix") || d.includes("spotify") || d.includes("amazon prime") || d.includes("youtube")) return "Subscrições";
  if (d.includes("farmacia") || d.includes("farmácia") || d.includes("medico") || d.includes("médico") || d.includes("hospital") || d.includes("clinica")) return "Saúde";
  if (d.includes("coinbase") || d.includes("binance") || d.includes("crypto") || d.includes("revolut digital assets")) return "Cripto";
  if (d.includes("salary") || d.includes("salario") || d.includes("salário") || d.includes("payroll") || d.includes("wage")) return "Rendimento";
  if (type === "Topup") return "Rendimento";
  return "Outros";
}

export function parseRevolutExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // Find header row (contains "Type", "Amount", etc.)
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].includes("Type") && rows[i].includes("Amount")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error("Formato do ficheiro não reconhecido.");

  const headers = rows[headerIdx].map(h => (h || "").toString().trim());
  const getCol = (name) => headers.indexOf(name);

  const COL = {
    type:        getCol("Type"),
    product:     getCol("Product"),
    startedDate: getCol("Started Date"),
    completedDate: getCol("Completed Date"),
    description: getCol("Description"),
    amount:      getCol("Amount"),
    currency:    getCol("Currency"),
    state:       getCol("State"),
  };

  const txs = [];
  const skipped = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const state       = (row[COL.state] || "").toString().trim().toUpperCase();
    const type        = (row[COL.type] || "").toString().trim();
    const description = (row[COL.description] || "").toString().trim();
    const amountRaw   = row[COL.amount];
    const currency    = (row[COL.currency] || "EUR").toString().trim();
    const dateRaw     = row[COL.startedDate];

    // Skip pending or failed
    if (state !== "COMPLETED") {
      skipped.push(`${description} (${state})`);
      continue;
    }

    // Skip non-EUR
    if (currency !== "EUR") {
      skipped.push(`${description} (${currency})`);
      continue;
    }

    // Skip internal pocket movements
    const descLower = description.toLowerCase();
    if (IGNORE_DESCRIPTIONS.some(ig => descLower.includes(ig))) {
      skipped.push(`${description} (interno)`);
      continue;
    }

    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount === 0) continue;

    // Format date as DD/MM/YYYY
    let dateStr = "";
    if (dateRaw instanceof Date) {
      const d = dateRaw;
      dateStr = `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
    } else if (typeof dateRaw === "string") {
      // "2026-04-06 09:11:09" → "06/04/2026"
      const parts = dateRaw.split(" ")[0].split("-");
      if (parts.length === 3) dateStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
    }

    const txType = amount > 0 ? "income" : "expense";
    const category = guessCategory(type, description);

    txs.push({
      description,
      amount: Math.abs(amount),
      type: txType,
      category,
      account: "Revolut",
      date: dateStr,
      scheduled: false,
    });
  }

  return { txs, skipped };
}
