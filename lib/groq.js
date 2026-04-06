const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const PT_MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function todayStr() {
  return new Date().toLocaleDateString("pt-PT");
}

function makeSystem(accts) {
  const names = Object.keys(accts).join(", ");
  const defaultAcct = Object.keys(accts)[0] || "Revolut";
  const today     = todayStr();
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("pt-PT");
  const dayBefore = new Date(Date.now() - 172800000).toLocaleDateString("pt-PT");
  const thisYear  = new Date().getFullYear();

  return `És um assistente de finanças pessoais português. Devolve APENAS JSON válido sem texto extra.
Hoje é ${today}. Ontem foi ${yesterday}. Anteontem foi ${dayBefore}. Ano corrente: ${thisYear}.

DATAS: Sempre inclui "date":"DD/MM/YYYY" em cada transação.
- "hoje"=>${today}; "ontem"=>${yesterday}; "anteontem"=>${dayBefore}
- "dia 5" => dia 5 do mês atual no formato DD/MM/YYYY
- "5 de março" ou "5/3" => 05/03/${thisYear}
- Data sem ano => assume ${thisYear}
- Sem menção de data => usa hoje (${today})

AGENDAMENTOS: Se a data for no futuro, adiciona "scheduled":true à transação.

Categorias: Alimentação, Transportes, Subscrições, Saúde, Roupa, Família, Administrativo, Cripto, Rendimento, Outros.
Contas existentes: ${names}. Conta padrão: ${defaultAcct}.
"cash/dinheiro/nota"=Dinheiro (se existir); "moey"=Moey; "deblock"=Deblock; resto=conta padrão.
"recebi/entrou/ganho" de fonte externa=income; "gastei/paguei/comprei/abasteci"=expense.
TRANSFERÊNCIAS INTERNAS: "transferi/movi/passei [valor] de [conta] para [conta]" = type:"transfer". NÃO são income/expense.
CRIAR CONTA: "cria conta X" = {"newAccount":"X","reply":"..."}
MUDAR CONTA PADRÃO: "usa X" ou "conta padrão X" = {"setDefault":"X","reply":"..."}
RELATÓRIO: "resumo", "relatório", "quanto gastei", "saldo" = {"report":true,"reply":"..."}
Restaurantes/supermercados/café=Alimentação; gasolina/uber=Transportes; netflix=Subscrições; farmácia/médico=Saúde; roupa=Roupa; família=Família; cripto=Cripto; salário=Rendimento.

IMPORTANTE: "amount" é SEMPRE um número positivo (ex: 480, NUNCA -480). O sinal é determinado pelo "type", não pelo "amount".
JSON transações: {"transactions":[{"description":"texto","amount":0.00,"type":"expense|income|transfer","category":"cat ou null","account":"nome","toAccount":"nome (só transfer)","date":"DD/MM/YYYY","scheduled":false}],"reply":"..."}
JSON nova conta: {"newAccount":"NomeDaConta","reply":"..."}
JSON mudar padrão: {"setDefault":"NomeDaConta","reply":"..."}
JSON relatório: {"report":true,"reply":"..."}`;
}

export async function askGroq(userMessage, accts) {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        { role: "system", content: makeSystem(accts) },
        { role: "user",   content: userMessage },
      ],
    }),
  });

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return { transactions: [], reply: "Não percebi, reformula." };
  }
}
