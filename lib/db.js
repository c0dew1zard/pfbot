import { kv } from "@vercel/kv";

const DEFAULT_ACCTS = {
  "Revolut":  { color: "#6366f1" },
  "Moey":     { color: "#22c55e" },
  "Deblock":  { color: "#f59e0b" },
  "Dinheiro": { color: "#94a3b8" },
};

function userKey(phone, suffix) {
  // phone ex: "whatsapp:+351912345678" → safe key
  const safe = phone.replace(/[^a-zA-Z0-9+]/g, "_");
  return `user:${safe}:${suffix}`;
}

export async function getAccts(phone) {
  const data = await kv.get(userKey(phone, "accts"));
  return data || DEFAULT_ACCTS;
}

export async function setAccts(phone, accts) {
  await kv.set(userKey(phone, "accts"), accts);
}

export async function getTxs(phone) {
  const data = await kv.get(userKey(phone, "txs"));
  return data || [];
}

export async function addTxs(phone, newTxs) {
  const existing = await getTxs(phone);
  const merged = [...existing, ...newTxs.map(tx => ({
    ...tx,
    id: `${Date.now()}${Math.random()}`,
    amount: Math.abs(tx.amount || 0),
  }))];
  await kv.set(userKey(phone, "txs"), merged);
  return merged;
}

export async function setDefault(phone, accountName) {
  const accts = await getAccts(phone);
  if (!accts[accountName]) return false;
  const { [accountName]: target, ...rest } = accts;
  await setAccts(phone, { [accountName]: target, ...rest });
  return true;
}

export async function deleteAllTxs(phone) {
  await kv.set(userKey(phone, "txs"), []);
}

export async function deleteLastTx(phone) {
  const txs = await getTxs(phone);
  if (!txs.length) return null;
  const removed = txs[txs.length - 1];
  await kv.set(userKey(phone, "txs"), txs.slice(0, -1));
  return removed;
}

export async function deleteTxByDescription(phone, term) {
  const txs = await getTxs(phone);
  const lower = term.toLowerCase();
  const idx = [...txs].reverse().findIndex(t =>
    (t.description || "").toLowerCase().includes(lower)
  );
  if (idx === -1) return null;
  const realIdx = txs.length - 1 - idx;
  const removed = txs[realIdx];
  txs.splice(realIdx, 1);
  await kv.set(userKey(phone, "txs"), txs);
  return removed;
}

export async function addAccount(phone, name) {
  const accts = await getAccts(phone);
  if (accts[name]) return false;
  const COLORS = ["#e879f9","#38bdf8","#fb7185","#34d399","#fbbf24","#a78bfa"];
  const used = Object.values(accts).map(a => a.color);
  const free = COLORS.find(c => !used.includes(c)) || COLORS[0];
  accts[name] = { color: free };
  await setAccts(phone, accts);
  return true;
}
