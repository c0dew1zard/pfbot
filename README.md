# Finanças Bot — WhatsApp + Vercel

Assistente de finanças pessoais via WhatsApp. Regista transações por linguagem natural e gera relatórios.

---

## Deploy (10 minutos)

### 1. Vercel KV (base de dados)

1. Vai ao dashboard do Vercel → projeto → **Storage** → **Create Database** → **KV**
2. Liga o KV ao projeto — as variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` são adicionadas automaticamente

### 2. Variáveis de ambiente no Vercel

Em **Settings → Environment Variables**, adiciona:

| Variável | Valor |
|---|---|
| `GROQ_API_KEY` | A tua key do Groq |
| `TWILIO_ACCOUNT_SID` | Do dashboard Twilio |
| `TWILIO_AUTH_TOKEN` | Do dashboard Twilio |
| `ALLOWED_NUMBER` | `whatsapp:+351912345678` (o teu número) |

### 3. Deploy

```bash
# Instala Vercel CLI (se não tiveres)
npm i -g vercel

# Na pasta do projeto
vercel --prod
```

Ou faz push para um repositório GitHub ligado ao Vercel — deploy automático.

### 4. Configurar Twilio Sandbox

1. Twilio Console → **Messaging → Try it out → Send a WhatsApp message**
2. Segue as instruções para activar o Sandbox no teu telemóvel
3. Em **Sandbox Settings → When a message comes in**, coloca:
   ```
   https://o-teu-projecto.vercel.app/api/webhook
   ```
   Método: **HTTP POST**
4. Guarda

---

## Utilização

| Mensagem | Resultado |
|---|---|
| "paguei 480€ de renda" | Regista despesa |
| "recebi 1000 da Seeksmarter" | Regista receita |
| "transferi 200 da Revolut para Moey" | Regista transferência |
| "resumo" / "saldo" | Relatório do mês atual |
| "relatório abril" | Relatório de abril |
| "quanto gastei" / "relatório tudo" | Relatório total |
| "cria conta Wise" | Cria nova conta |
| "conta padrão Moey" | Muda conta padrão |
| "ajuda" | Lista de comandos |

---

## Estrutura

```
api/
  webhook.js     ← endpoint Twilio (Vercel Serverless)
lib/
  groq.js        ← chamadas à API Groq (Llama 3.3)
  db.js          ← operações Vercel KV
  report.js      ← geração de relatórios em texto
```
...