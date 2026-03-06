# Kite Scalper Engine (Algo Scalper BE)

A production-ready, Zerodha Kite Connect–powered **scalping engine** that:

- Streams live ticks over WebSocket (KiteTicker)
- Builds aligned candles for multiple intervals
- Runs multiple strategies in parallel with regime + quality gates
- Sizes positions with risk- and margin-aware logic
- Places entry + SL + target orders (including options/F&O support)
- Handles restart-safe reconciliation, kill switch, and runtime halts
- Emits telemetry, optimizer feedback, audit logs, and alerting

> **This is a live-trading system**. Read the risk, safety, and configuration sections carefully before enabling trading.

---

## Table of contents

- [Key capabilities](#key-capabilities)
- [Architecture overview](#architecture-overview)
- [Quick start](#quick-start)
- [Environment configuration](#environment-configuration)
- [Kite login & token flow](#kite-login--token-flow)
- [Market data & subscriptions](#market-data--subscriptions)
- [Strategies](#strategies)
- [Signal quality & regime gates](#signal-quality--regime-gates)
- [Risk management](#risk-management)
- [Order management & execution](#order-management--execution)
- [Options & F&O mode](#options--fo-mode)
- [Dynamic exits & scale-out](#dynamic-exits--scale-out)
- [Optimizer](#optimizer)
- [Telemetry & analytics](#telemetry--analytics)
- [Alerts & notifications](#alerts--notifications)
- [Sockets / live dashboard stream](#sockets--live-dashboard-stream)
- [API endpoints](#api-endpoints)
- [Scripts](#scripts)
- [Deployment (Render)](#deployment-render)
- [Operations & runbook](#operations--runbook)
- [Troubleshooting](#troubleshooting)

---

## Key capabilities

- **Live market data:** Uses KiteTicker for tick-level data; supports quote/ltp/full tick modes per token class.
- **Candle building:** 1m/3m/etc aligned candles with DB persistence and optional retention TTL.
- **Multi-strategy engine:** EMA pullback, VWAP reclaim, ORB, BB squeeze, breakout, volume spike, fakeout, RSI fade, wick reversal.
- **Signal confirmation and gating:** Multi-timeframe filters, ATR/volatility gates, range filters, confidence thresholds, cost/edge gates.
- **Risk controls:** Daily loss caps, kill switch, trade count limits, max exposure, SL/target gating, and trading windows.
- **Options/F&O support:** Index futures or options, selection logic for ATM/ITM/OTM, spread/IV/gamma filters, premium bands.
- **Dynamic exit management:** True breakeven, ATR-based trails, TP tightening controls, optional scale-out.
- **Telemetry & optimizer:** Signal telemetry, trade telemetry, fee-multiple scoring, adaptive optimizer with blocklists and RR tuning.
- **Admin & ops:** Secure admin APIs, health checks, audits, alerts, and market calendar support.

---

## Architecture overview

**Core runtime flow**

1. **Boot**: Loads env config, connects MongoDB, ensures retention indexes, starts telemetry + optimizer, watches token storage.
2. **Token watcher**: Fetches latest Kite access token from MongoDB; halts trading if missing or invalid.
3. **Ticker**: Connects to KiteTicker and streams ticks into the pipeline.
4. **Pipeline**: Builds candles, computes indicators, evaluates strategies and gates, and emits validated signals.
5. **Trader**: Calculates sizing, constructs order plans (entry/SL/target), places orders, and reconciles execution states.
6. **Telemetry**: Aggregates signal decisions, trade outcomes, and optimizer signals for performance tuning.

**Supporting services**

- **Market calendar**: Blocks trades on holidays and supports special sessions.
- **Risk & kill switch**: Runtime controls that can stop trading immediately.
- **Alerts + audit**: Notifications and compliance-style logs for admin actions.

---

## Quick start

```bash
npm i
npm run sync:instruments     # optional but recommended for SUBSCRIBE_SYMBOLS
npm run dev
```

**Health checks**

- `GET http://localhost:4001/health` – liveness
- `GET http://localhost:4001/ready` – ready only if ticker connected + not halted

---

## Environment configuration

The engine is fully configurable via environment variables. Below are **core settings** plus feature-specific groups. Use `.env` locally or set these in your host runtime (Render/PM2/Docker/K8s).

### Minimum required

```env
# MongoDB
MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net
MONGO_DB=algo_scalper

# Kite
KITE_API_KEY=your_key
KITE_API_SECRET=your_secret

# Token storage
TOKENS_COLLECTION=broker_tokens

# Trading on/off (start false)
TRADING_ENABLED=false
```

### Admin + security

```env
ADMIN_API_KEY=super-secret
RBAC_ENABLED=false
RBAC_HEADER=x-role
RBAC_DEFAULT_ROLE=admin
```

- **Production behavior:** If `NODE_ENV=production` and `ADMIN_API_KEY` is missing, all `/admin/*` endpoints return 503.

### Subscription

```env
# Use symbols (recommended)
SUBSCRIBE_SYMBOLS=NSE:RELIANCE,NSE:TCS

# Or tokens (legacy)
SUBSCRIBE_TOKENS=738561

# Strict resolution (optional)
STRICT_SUBSCRIBE_SYMBOLS=false
```

### Candles + market hours

```env
CANDLE_INTERVALS=1,3
CANDLE_TZ=Asia/Kolkata
MARKET_OPEN=09:15
MARKET_CLOSE=15:30

HOLIDAY_CALENDAR_ENABLED=false
HOLIDAY_CALENDAR_FILE=config/market_calendar.json
SPECIAL_SESSIONS_ENABLED=false
```

### Strategy selection

```env
STRATEGIES=ema_pullback,vwap_reclaim,orb,bb_squeeze,breakout,volume_spike,fakeout,rsi_fade,wick_reversal
SIGNAL_INTERVALS=1
```

### Risk / limits

```env
RISK_PER_TRADE_INR=300
MAX_TRADES_PER_DAY=8
MAX_OPEN_POSITIONS=1
MAX_CONSECUTIVE_FAILURES=3
DAILY_MAX_LOSS=1000
AUTO_EXIT_ON_DAILY_LOSS=true
STOP_NEW_ENTRIES_AFTER=15:00
FORCE_FLATTEN_AT=15:20
```

### Telemetry + optimizer

```env
TELEMETRY_ENABLED=true
TELEMETRY_FLUSH_SEC=60
TELEMETRY_TRADES_ENABLED=true

OPTIMIZER_ENABLED=true
OPT_LOOKBACK_N=60
OPT_MIN_SAMPLES=20
OPT_BLOCK_FEE_MULTIPLE_AVG_MIN=3
OPT_BLOCK_TTL_MIN=120
```

> **Tip:** The full config surface is defined in `src/config.js`. Use it as the canonical list and reference for defaults.

---

## Kite login & token flow

The engine **never stores** the access token in code. It expects the latest token in MongoDB and continuously watches for updates.

### Option A: Server redirect flow

1. Set your Kite app `redirect_url` to:
   ```
   https://<host>/kite-redirect
   ```
2. Login to Kite → your browser gets redirected to `/kite-redirect?request_token=...`
3. Server exchanges the request token and stores the access token.

### Option B: Frontend-driven flow

If your FE handles the login redirect:

```http
POST /admin/kite/session
{ "request_token": "..." }
```

The server exchanges and stores the token. All `/admin/*` routes require `ADMIN_API_KEY` in production.

---

## Market data & subscriptions

**Two subscription modes**

- **Symbols (recommended):** `SUBSCRIBE_SYMBOLS=NSE:RELIANCE,NSE:TCS`
- **Tokens (legacy):** `SUBSCRIBE_TOKENS=738561`

If both are provided, the engine subscribes to the **union**.

**Instrument sync** (recommended)

- `npm run sync:instruments` downloads the instrument dump and caches token data for the requested symbols.

**Tick modes** (performance tuning)

- `TICK_MODE_DEFAULT`: default for most tokens (`quote` or `full`)
- `TICK_MODE_TRADE`: tokens actively traded
- `TICK_MODE_UNDERLYING`: underlying instruments for options

---

## Strategies

The default strategy set includes:

- `ema_pullback` – trend continuation pullbacks
- `vwap_reclaim` – reclaim of VWAP after deviation
- `orb` – opening range breakout
- `bb_squeeze` – Bollinger band squeeze breakout
- `breakout` – range breakout
- `volume_spike` – high volume momentum
- `fakeout` – failed breakout reversal
- `rsi_fade` – RSI mean reversion
- `wick_reversal` – long-wick exhaustion reversal

**Per-strategy tuning** is available via env variables in `src/config.js` (look for `EMA_*`, `RSI_*`, `BB_*`, `FAKEOUT_*`, etc.).

---

## Signal quality & regime gates

Signals can be filtered by:

- **Multi-timeframe trend confirmation**
- **ATR/volatility thresholds**
- **Relative volume filters**
- **Spread filters**
- **Regime alignment** (trend vs range vs open)
- **Minimum confidence** thresholds
- **Cost/edge gates** (expected move vs estimated costs)

These gates reduce overtrading and block low-quality setups.

---

## Risk management

The engine includes layered risk controls:

- **Daily loss caps** and auto-exit
- **Max trades per day / open positions / consecutive failures**
- **Symbol cooldown windows**
- **Risk-per-trade sizing with margin validation**
- **Kill switch** (`/admin/kill`)
- **Runtime halt** (set automatically on fatal errors)
- **Trading window enforcement** (stop new entries after a cutoff; flatten positions before close)

---

## Order management & execution

- Entry order type can be **MARKET** or **LIMIT**
- Stop-loss orders are placed with optional buffer rules
- Target orders can be broker-managed or virtual (for options)
- **Reconciliation** ensures safety on restart and session recovery

---

## Options & F&O mode

Enable F&O trading with:

```env
FNO_ENABLED=true
FNO_MODE=FUT  # or OPT
```

### Futures

- Contracts are selected based on underlying, expiry, lot sizes, and policy.
- Enforces minimum days to expiry and expiry-day cutoffs.

### Options

- Supports **ATM/ITM/OTM** strike selection and strike scan around ATM.
- Filters by **premium bands**, **spread**, **depth**, **delta**, **gamma**, **IV**, and **OI walls**.
- Handles **premium-aware SL/target planning** and **dynamic exit logic**.

---

## Dynamic exits & scale-out

Dynamic exits are optional and can be enabled to:

- Move SL to true breakeven after reaching a profit threshold
- Trail SL based on ATR or option premium volatility
- Tighten targets after profit is achieved (can be disabled for pro-style)
- Scale out via TP1 + runner mode

---

## Optimizer

The adaptive optimizer:

- Tracks **feeMultiple = grossPnL / estimated costs** by symbol × strategy × bucket
- Auto-blocks combinations that underperform (rolling average below threshold)
- Adjusts RR based on volatility regime
- Persists state to MongoDB for fast restarts

Admin controls:

- `GET /admin/optimizer/snapshot`
- `POST /admin/optimizer/flush`
- `POST /admin/optimizer/reload`
- `POST /admin/optimizer/reset`

---

## Telemetry & analytics

Two major telemetry layers are provided:

1. **Signal telemetry** (candidates, accepted, blocked, rejection reasons)
2. **Trade telemetry** (PnL, estimated costs, fee-multiple per trade)

This data is available in memory and persisted daily to MongoDB.

---

## Alerts & notifications

Alerting supports:

- Startup/shutdown
- Token updates and session failures
- Order placement/fills
- Halts, kill switch, rejection events

**Telegram** is supported out of the box. Configure:

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat_id>
TELEGRAM_MIN_LEVEL=info
TELEGRAM_DETAILED=true
TELEGRAM_PARSE_MODE=HTML
TELEGRAM_MAX_META_CHARS=1500
```

When `TELEGRAM_DETAILED=true`, alerts are sent with severity badge, timestamp, host and a structured meta block to make operational triage easier.

---

## Sockets / live dashboard stream

The engine exposes live websocket streams (Socket.IO) for:

- Status updates
- Subscriptions
- Trade events
- Chart/candle streaming

Configure via:

```env
SOCKET_ENABLED=true
SOCKET_PATH=/socket.io
WS_STATUS_INTERVAL_MS=2000
WS_TRADES_INTERVAL_MS=2000
WS_CHART_INTERVAL_MS=1000
```

---

## API endpoints

A **complete API reference with sample payloads** is available at:

- [`api-endpoints.md`](./api-endpoints.md)

Key endpoints:

- Public
  - `GET /health`
  - `GET /ready`

- Admin (requires API key in production)
  - `GET /admin/status`
  - `POST /admin/trading?enabled=true|false`
  - `POST /admin/kill`
  - `POST /admin/halt/reset`
  - `GET /admin/optimizer/snapshot`
  - `GET /admin/telemetry/snapshot`
  - `GET /admin/trade-telemetry/snapshot`

---

## Scripts

Useful CLI utilities:

- **Download and cache instruments**
  ```bash
  npm run sync:instruments
  ```
- **Replay signals** (backtest-style replay in dev)
  ```bash
  npm run replay:signals
  ```
- **Critical health check** (used for monitoring)
  ```bash
  npm run health:critical
  ```
- **Run backtest engine** (supports EQ and dynamic OPT contracts)
  ```bash
  npm run bt:run -- --mode=OPT --token=260105 --underlying="NIFTY 50" --dynamicContracts=true --from=2025-01-01 --to=2025-01-31 --interval=1 --qty=50 --forceEodExit=true
  ```
- **Prepare option universe + historical candles for backtests**
  ```bash
  npm run bt:prepare-options -- --underlyingToken=260105 --underlying="NIFTY 50" --optionType=ALL --from=2025-01-01 --to=2025-01-31 --interval=1 --refreshInstruments=true
  ```

---

## Deployment (Render)

See [`RENDER_DEPLOY.md`](./RENDER_DEPLOY.md) for step-by-step Render setup, health checks, and Telegram alerts.

---

## Operations & runbook

### Safe startup checklist

1. Deploy with `TRADING_ENABLED=false`.
2. Confirm:
   - `/health` returns 200
   - `/ready` returns 200 after ticker connects
   - Alerts (Telegram) are working
   - No legacy trade statuses are present in first live-session checks:
     ```bash
     curl -H "x-api-key: $ADMIN_API_KEY" \
       "http://localhost:4001/admin/trades/legacy-statuses?sinceHours=24&limit=300"
     ```
     (`hasLegacyStatuses=false` is expected)
3. Enable trading during market hours only.
4. Start with a **single symbol** and conservative risk.

### Runtime controls

- **Enable/disable trading**

  ```bash
  curl -X POST -H "x-api-key: $ADMIN_API_KEY" \
    "http://localhost:4001/admin/trading?enabled=false"
  ```

- **Kill switch** (emergency stop)
  ```bash
  curl -X POST -H "x-api-key: $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"enabled": true}' \
    "http://localhost:4001/admin/kill"
  ```

---

## Troubleshooting

### Token issues

- If `kite` access token is missing or invalid, the engine halts trading and keeps polling.
- Use `/kite-redirect` or `/admin/kite/session` to refresh the token.

### Not ready

- `/ready` returns 503 if ticker is disconnected or a halt is active.
- Check `/admin/status` and `/admin/health/critical` for detailed diagnostics.

### Trading halted

- Check `/admin/status` for `haltInfo`
- Use `/admin/halt/reset` after resolving the underlying issue.

---

## Reference lists (symbols)

The repository includes curated lists for NIFTY 50, Bank NIFTY, and tiered stock groups in this README (below). Keep them updated to match your trading universe.

<!-- NIFTY 50 COMPLETE LIST  -->

ADANIENT, ADANIPORTS, APOLLOHOSP, ASIANPAINT, AXISBANK, BAJAJ-AUTO, BAJFINANCE, BAJAJFINSV, BEL, BHARTIARTL, CIPLA, COALINDIA, DRREDDY, EICHERMOT, ETERNAL, GRASIM, HCLTECH, HDFCBANK, HDFCLIFE, HEROMOTOCO, HINDALCO, HINDUNILVR, ICICIBANK, INDUSINDBK, INFY, ITC, JIOFIN, JSWSTEEL, KOTAKBANK, LT, M&M, MARUTI, NESTLEIND, NTPC, ONGC, POWERGRID, RELIANCE, SBILIFE, SHRIRAMFIN, SBIN, SUNPHARMA, TCS, TATACONSUM, TATAMOTORS, TATASTEEL, TECHM, TITAN, TRENT, ULTRACEMCO, WIPRO

<!-- NIFTY 50 LIST PRICE BELOW 1K -->

BAJFINANCE,BEL,COALINDIA,ETERNAL,HDFCBANK,HDFCLIFE,HINDALCO,INDUSINDBK,ITC,JIOFIN,KOTAKBANK,NTPC,ONGC,POWERGRID,SHRIRAMFIN,TATAMOTORS,TATASTEEL,WIPRO,ADANIPORTS,ICICIBANK,JSWSTEEL,SBIN

<!-- BANK NIFTY LIST  -->

AUBANK,AXISBANK,BANDHANBNK,FEDERALBNK,HDFCBANK,ICICIBANK,IDFCFIRSTB,INDUSINDBK,KOTAKBANK,PNB,RBLBANK,SBIN

<!-- NIFTY NEXT 50 SYMBOLS -->

ADANIENSOL, ADANIGREEN, ADANIPOWER, AMBUJACEM, BAJAJHFL, BANKBARODA, BPCL, CANBK, CGPOWER, DLF, GAIL, HINDZINC, INDHOTEL, IOC, IRFC, JSWENERGY, LICI, MOTHERSON, PFC, PNB, RECLTD, TATAPOWER, VBL, VEDL, ZYDUSLIFE,PIDILITIND,NAUKRI,UNITDSPR

<!--  -->

ADANIENT, ADANIPORTS, APOLLOHOSP, ASIANPAINT, AXISBANK, BAJAJ-AUTO, BAJAJFINSV, BHARTIARTL, CIPLA, DIVISLAB, DRREDDY, EICHERMOT, GRASIM, HAL, HAVELLS, HCLTECH, HEROMOTOCO, HINDUNILVR, ICICIBANK, INFY, JINDALSTEL, JSWSTEEL, LT, LTIM, M&M, MARUTI, NAUKRI, NESTLEIND, PIDILITIND, RELIANCE, SBILIFE, SBIN, SUNPHARMA, TATACONSUM, TCS, TECHM, TITAN, TRENT, TVSMOTOR, ULTRACEMCO
ALOKINDS, BELRISE, CENTRALBK, CGCL, EASEMYTRIP, ETERNAL, HFCL, IBULHSGFIN, IDBI, IDFCFIRSTB, IEX, IFCI, JMFINANCIL, JPPOWER, NBCC, NETWORK18, NYKAA, OLAELEC, RBLBANK, RPOWER, RTNINDIA, RTNPOWER, SAGILITY, SAMMAANCAP, SJVN, STARHEALTH, SWIGGY, TATAMOTORS, UCOBANK, VMM, WELSPUNLIV, ZEEL

<!-- FINAL LIST  -->

Tier-1 71(best for your current system)

BAJFINANCE, BEL, COALINDIA, HDFCBANK, HDFCLIFE, HINDALCO, INDUSINDBK, ITC, JIOFIN, KOTAKBANK, NTPC, ONGC, POWERGRID, SHRIRAMFIN, TATAMOTORS, TATASTEEL, WIPRO, ADANIPORTS, ICICIBANK, JSWSTEEL, SBIN, AXISBANK, AMBUJACEM, BPCL, CGPOWER, GAIL, HINDZINC, INDHOTEL, IOC, MOTHERSON, PFC, RECLTD, TATAPOWER, VBL, VEDL, ZYDUSLIFE, PIDILITIND, NAUKRI, UNITDSPR, ADANIENT, BAJAJFINSV, BHARTIARTL, CIPLA, DRREDDY, GRASIM, HAL, HAVELLS, HCLTECH, HINDUNILVR, INFY, JINDALSTEL, LT, RELIANCE, SBILIFE, SUNPHARMA, TATACONSUM, TECHM

Tier-2 32(OK, but watch spread/volatility and gap risk)

ETERNAL, AUBANK, BANDHANBNK, FEDERALBNK, IDFCFIRSTB, PNB, RBLBANK, ADANIENSOL, ADANIGREEN, ADANIPOWER, BAJAJHFL, BANKBARODA, CANBK, DLF, IRFC, JSWENERGY, LICI, CENTRALBK, CGCL, HFCL, IBULHSGFIN, IDBI, IEX, NBCC, NYKAA, OLAELEC, SJVN, STARHEALTH, SWIGGY, UCOBANK, ZEEL

Tier-3 (avoid for scalping unless you keep strict gates + only trade when conditions are perfect)

ALOKINDS, BELRISE, EASEMYTRIP, IFCI, JMFINANCIL, JPPOWER, NETWORK18, RPOWER, RTNINDIA, RTNPOWER, SAGILITY, SAMMAANCAP, VMM, WELSPUNLIV

Kite login URL template:

`https://kite.zerodha.com/connect/login?v=3&api_key=<KITE_API_KEY>`

<!-- prettier-ignore-start -->
Price ^
      |
  210 |                          /\
      |                         /  \
  200 |                        /    \      Exit happens here
      |               Peak -> *      \____ (Trail SL hit)
  192 |------------------------|--------------------  Trailing SL (= 200 - 8)
      |                      /|
  188 |----------- BE lock --|-|--------------------  (when profit hits threshold, SL jumps to BE+buffer)
      |                    / |
  180 |---- Entry --------*  |
      |                  |   |
  170 |---- Initial SL ---|---|---------------------  (risk-based SL)
      |
      +--------------------------------------------------> Time
<!-- prettier-ignore-end -->

What to expect now (your “no surprises” summary)
With your current env + code:
Dead/no-momentum trades will be cut around 6 minutes (but only if UL also didn’t move enough).
Stagnant trades will be cut around 20 minutes unless they proved strength.
Winners that touch +1R will stop giving back to tiny greens:
SL will jump to protect ~₹175 (0.25R) minimum.
Strong winners beyond 1.5R will trail tighter and exit quicker on pullbacks.
Time-stop exits will try a fast LIMIT first, and if not filled in ~2s they’ll escalate.
After exits, you’ll see cooldown behavior based on exit reason.

<!-- **********************Math for your 4 capital levels (₹50k / 1L / 1.5L / 2L)************ -->

Daily max loss (6.5%) and per-trade budget (÷4)

₹50,000 → daily = ₹3,250 → per-trade budget = ₹812.5
₹1,00,000 → daily = ₹6,500 → per-trade budget = ₹1,625
₹1,50,000 → daily = ₹9,750 → per-trade budget = ₹2,437.5
₹2,00,000 → daily = ₹13,000 → per-trade budget = ₹3,250
