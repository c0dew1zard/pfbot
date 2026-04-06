const PT_MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

const CAT_EMOJI = {
  "Alimentação": "🍽️", "Transportes": "🚗", "Subscrições": "📺",
  "Saúde": "💊", "Roupa": "👕", "Família": "👨‍👩‍👧", "Administrativo": "🏠",
  "Cripto": "₿", "Rendimento": "💼", "Outros": "📦",
};

function txMonthKey(tx) {
  const p = (tx.date || "").split("/");
  return p.length === 3 ? `${p[2]}-${p[1]}` : "?";
}

function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${PT_MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

export function buildReport(txs, accts, filterMonth = null) {
  const confirmed = txs.filter(t => !t.scheduled);
  const scheduled = txs.filter(t =>  t.scheduled);

  // detect current month if no filter
  if (!filterMonth) {
    const now = new Date();
    filterMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  }

  const filtered = filterMonth === "all"
    ? confirmed
    : confirmed.filter(t => txMonthKey(t) === filterMonth);

  // Saldo anterior (tudo antes do mês filtrado)
  let previousIncome = 0;
  let previousExpense = 0;
  if (filterMonth !== "all") {
    const previous = confirmed.filter(t => txMonthKey(t) < filterMonth);
    previousIncome  = previous.filter(t => t.type === "income" ).reduce((s,t) => s+t.amount, 0);
    previousExpense = previous.filter(t => t.type === "expense").reduce((s,t) => s+t.amount, 0);
  }
  const previousBal = previousIncome - previousExpense;

  // Monthly movements
  const mIncome  = filtered.filter(t => t.type === "income" ).reduce((s,t) => s+t.amount, 0);
  const mExpense = filtered.filter(t => t.type === "expense").reduce((s,t) => s+t.amount, 0);
  const mBal     = mIncome - mExpense;
  const currentBal = previousBal + mBal;

  const label = filterMonth === "all" ? "Total geral" : monthLabel(filterMonth);

  let msg = filterMonth !== "all"
    ? `💰 *Saldo Anterior: ${previousBal >= 0 ? "+" : ""}€${previousBal.toFixed(2)}*\n\n`
    : "";
  msg += `📊 *Movimentos — ${label}*\n`;
  msg += `📈 Entrou: +€${mIncome.toFixed(2)}\n`;
  msg += `📉 Saiu: -€${mExpense.toFixed(2)}\n`;
  msg += `↕️ Balanço do período: ${mBal >= 0 ? "+" : ""}€${mBal.toFixed(2)}\n`;

  // by account
  const acctNames = Object.keys(accts);
  const acctLines = acctNames.map(name => {
    const i    = filtered.filter(t => t.type==="income"   && t.account===name).reduce((s,t)=>s+t.amount,0);
    const e    = filtered.filter(t => t.type==="expense"  && t.account===name).reduce((s,t)=>s+t.amount,0);
    const tOut = filtered.filter(t => t.type==="transfer" && t.account===name).reduce((s,t)=>s+t.amount,0);
    const tIn  = filtered.filter(t => t.type==="transfer" && t.toAccount===name).reduce((s,t)=>s+t.amount,0);
    const b    = i - e - tOut + tIn;
    if (i===0 && e===0 && tOut===0 && tIn===0) return null;
    return `  • ${name}: ${b>=0?"+":""}€${b.toFixed(2)}`;
  }).filter(Boolean);

  if (acctLines.length) {
    msg += `\n*Contas:*\n${acctLines.join("\n")}\n`;
  }

  // by category
  const byCat = filtered.filter(t => t.type==="expense")
    .reduce((acc,t) => { acc[t.category]=(acc[t.category]||0)+t.amount; return acc; }, {});
  const cats = Object.entries(byCat).sort((a,b) => b[1]-a[1]);

  if (cats.length) {
    msg += `\n*Gastos por categoria:*\n`;
    cats.forEach(([cat, total]) => {
      const emoji = CAT_EMOJI[cat] || "📦";
      msg += `  ${emoji} ${cat}: €${total.toFixed(2)}\n`;
    });
  }

  // recent transactions (last 5)
  const recent = [...filtered].reverse().slice(0, 5);
  if (recent.length) {
    msg += `\n*Últimas transações:*\n`;
    recent.forEach(tx => {
      const sign = tx.type==="income" ? "+" : tx.type==="transfer" ? "⇄" : "-";
      msg += `  \`#${tx.id}\` ${sign}€${tx.amount.toFixed(2)} ${tx.description}\n`;
    });
  }

  // scheduled
  if (scheduled.length) {
    msg += `\n⏰ *Agendados (${scheduled.length}):*\n`;
    scheduled.slice(0,3).forEach(tx => {
      msg += `  ${tx.date} — ${tx.description}: €${tx.amount.toFixed(2)}\n`;
    });
    if (scheduled.length > 3) msg += `  _...e mais ${scheduled.length-3}_\n`;
  }

  if (filterMonth !== "all") {
    msg += `\n💰 *Saldo Corrente: ${currentBal >= 0 ? "+" : ""}€${currentBal.toFixed(2)}*`;
  }

  return msg.trim();
}

export function detectMonthFilter(text) {
  const PT_MONTHS_MAP = {
    "janeiro":"01","fevereiro":"02","março":"03","marco":"03",
    "abril":"04","maio":"05","junho":"06","julho":"07",
    "agosto":"08","setembro":"09","outubro":"10",
    "novembro":"11","dezembro":"12",
  };
  const lower = text.toLowerCase();
  if (lower.includes("tudo") || lower.includes("total") || lower.includes("sempre")) return "all";
  const year = new Date().getFullYear();
  for (const [name, num] of Object.entries(PT_MONTHS_MAP)) {
    if (lower.includes(name)) return `${year}-${num}`;
  }
  return null; // default: current month
}
