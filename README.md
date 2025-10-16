# Crypto Bot Server (Paper Trading)

Server Node.js pronto per Render/Railway. **Parte fermo**, avvia con POST `/start`.
Dati di mercato da Binance (endpoint pubblici, senza chiavi). Ordini SOLO su carta (paper).

## Endpoint principali
- `GET /health` → `{"ok":true}`
- `GET /status` → stato bot (cash, equity, posizioni, segnali)
- `GET /trades` → storico operazioni
- `GET /positions` → posizioni aperte
- `POST /start` body opz.: `{ "symbols": ["BTCUSDT","ETHUSDT"], "loopSeconds": 30, "allocationPct": 0.1 }`
- `POST /stop`
- `POST /reset`
- `POST /buy` body: `{ "symbol": "BTCUSDT", "usd": 500 }`
- `POST /sell` body: `{ "symbol": "BTCUSDT" }`

## Deploy su Render
1) Carica questo repo su GitHub.
2) Su Render: New → Blueprint → collega il repo → deploy.
3) Variabili d'ambiente sono nel `render.yaml`.

## Avvio locale
npm install
cp .env.example .env
node server.js
curl http://localhost:8080/health
