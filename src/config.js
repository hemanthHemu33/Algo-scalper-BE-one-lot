const { z } = require("zod");
const { Settings } = require("luxon");
const fs = require("fs");
const path = require("path");
const { reportFault } = require("./runtime/errorBus");

// dotenv is for local development. In production, set env vars in the host (Render/PM2/Docker/K8s).
// We load .env only if it exists and DOTENV_ENABLED is not "false".
try {
  const enabled = String(process.env.DOTENV_ENABLED || "true") !== "false";
  if (enabled) {
    const dotenvPath =
      process.env.DOTENV_PATH || path.join(process.cwd(), ".env");
    if (fs.existsSync(dotenvPath)) {
      try {
        const raw = fs.readFileSync(dotenvPath, "utf8");
        const counts = new Map();
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
          if (!match) continue;
          const key = match[1];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        const dupes = Array.from(counts.entries())
          .filter(([, count]) => count > 1)
          .map(([key]) => key);
        if (dupes.length) {
          // eslint-disable-next-line no-console
          console.warn(
            `[config] duplicate keys detected in .env (${dupes.length}): ${dupes.join(
              ", ",
            )}`,
          );
        }
      } catch (err) {
        reportFault({
          code: "CONFIG_CATCH",
          err,
          message: "[src/config.js] caught and continued",
        });
      }
      // eslint-disable-next-line global-require
      require("dotenv").config({ path: dotenvPath });
    }
  }
} catch (err) {
  reportFault({
    code: "CONFIG_CATCH",
    err,
    message: "[src/config.js] caught and continued",
  });
}

const defaultTimezone = "Asia/Kolkata";
const resolvedTimezone =
  process.env.TZ || process.env.CANDLE_TZ || defaultTimezone;
process.env.TZ = resolvedTimezone;
Settings.defaultZone = resolvedTimezone;

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const schema = z.object({
  PORT: z.coerce.number().default(4001),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  RBAC_ENABLED: z.string().default("false"),
  RBAC_HEADER: z.string().default("x-role"),
  RBAC_DEFAULT_ROLE: z.string().default("viewer"),

  // CORS
  CORS_ORIGIN: z.string().optional(),

  // Socket.IO (dashboard streaming)
  SOCKET_ENABLED: z.string().default("true"),
  SOCKET_PATH: z.string().default("/socket.io"),
  WS_STATUS_INTERVAL_MS: z.coerce.number().default(2000),
  WS_SUBS_INTERVAL_MS: z.coerce.number().default(5000),
  WS_TRADES_INTERVAL_MS: z.coerce.number().default(2000),
  WS_CHART_INTERVAL_MS: z.coerce.number().default(1000),
  WS_CHART_MAX_DELTA: z.coerce.number().default(200),
  WS_CHART_INCLUDE_LIVE: z.string().default("true"),

  // Local dotenv loader toggle (config.js pre-loads dotenv using process.env too)
  DOTENV_ENABLED: z.string().optional(),
  DOTENV_PATH: z.string().optional(),
  PROFILE_PRESET: z.string().optional(),
  // First-live convenience flag: applies a conservative exit-management preset unless overridden explicitly.
  LIVE_CONSERVATIVE_PROFILE: boolFromEnv.default(false),
  PROFILE_VALIDATE: z.string().default("true"),

  // Observability / telemetry (pro tuning support)
  TELEMETRY_ENABLED: z.string().default("true"),
  TELEMETRY_FLUSH_SEC: z.coerce.number().default(60),
  TELEMETRY_RING_SIZE: z.coerce.number().default(300),
  TELEMETRY_DB_DAILY_COLLECTION: z.string().default("telemetry_signals_daily"),

  // Rejection histograms (symbol×strategy×time-bucket)
  TELEMETRY_REJECTIONS_ENABLED: z.string().default("true"),
  TELEMETRY_REJECTIONS_TOP_KEYS: z.coerce.number().default(200),

  // Trade outcome telemetry (fee-multiple, pnl vs costs)
  TELEMETRY_TRADES_ENABLED: z.string().default("true"),
  TELEMETRY_TRADES_DAILY_COLLECTION: z
    .string()
    .default("telemetry_trades_daily"),
  TELEMETRY_TRADES_RING_SIZE: z.coerce.number().default(300),

  // Fee-multiple scoring (grossPnl / estimatedCosts) persisted on closed trades
  FEE_MULTIPLE_ENABLED: z.string().default("true"),

  // Adaptive optimizer (auto-block weak strategy×symbol×bucket, dynamic RR)
  OPTIMIZER_ENABLED: z.string().default("true"),
  OPT_LOOKBACK_N: z.coerce.number().default(60),
  OPT_MIN_SAMPLES: z.coerce.number().default(20),
  OPT_BLOCK_FEE_MULTIPLE_AVG_MIN: z.coerce.number().default(3),
  OPT_BLOCK_TTL_MIN: z.coerce.number().default(120),
  OPT_BOOTSTRAP_LIMIT: z.coerce.number().default(2000),
  OPT_BUCKET_OPEN_END: z.string().default("10:00"),
  OPT_BUCKET_CLOSE_START: z.string().default("15:00"),
  OPT_LOG_DECISIONS: z.string().default("true"),

  // Pro optimizer extensions (performance-driven strategy control)
  OPT_BLOCK_SCOPE: z.string().default("BOTH"),
  OPT_MIN_SAMPLES_KEY: z.coerce.number().default(20),
  OPT_MIN_SAMPLES_STRATEGY: z.coerce.number().default(20),
  OPT_DEWEIGHT_ENABLED: z.string().default("true"),
  OPT_DEWEIGHT_MIN_SAMPLES: z.coerce.number().default(5),
  OPT_DEWEIGHT_CONF_MIN: z.coerce.number().default(0.5),
  OPT_DEWEIGHT_QTY_MIN: z.coerce.number().default(0.5),
  OPT_DEWEIGHT_APPLY_TO_QTY: z.string().default("false"),
  OPT_DEWEIGHT_HARD_VETO_ENABLED: z.string().default("false"),
  OPT_RECHECK_CONF_AFTER_DEWEIGHT: z.string().default("false"),
  OPT_SPREAD_PENALTY_BPS: z.coerce.number().default(15),
  OPT_SPREAD_BLOCK_BPS: z.coerce.number().default(30),
  OPT_SPREAD_PENALTY_CONF_MULT: z.coerce.number().default(0.85),
  OPT_SPREAD_SOFT_ACTION: z.string().default("RR_ONLY"),
  OPT_SPREAD_BLOCK_ENABLED: z.string().default("false"),
  OPT_KEY_MODE: z.string().default("NORMALIZED_V2"),
  OPT_STRATEGY_KEY_INCLUDE_OPT_TYPE: z.string().default("true"),
  OPT_STRATEGY_KEY_INCLUDE_STYLE: z.string().default("true"),
  OPTIMIZER_BOOTSTRAP_FROM_DB: z.string().default("true"),
  OPT_BOOTSTRAP_DAYS: z.coerce.number().default(7),

  // Optimizer state persistence (fast restart + stable self-pruning)
  OPT_STATE_PERSIST: z.string().default("true"),
  OPT_STATE_COLLECTION: z.string().default("optimizer_state"),
  OPT_STATE_ID: z.string().default("active"),
  OPT_STATE_FLUSH_SEC: z.coerce.number().default(15),
  OPT_STATE_MAX_KEYS: z.coerce.number().default(1500),
  OPT_STATE_VERSION: z.coerce.number().default(2),

  // Regime-aware RR floors
  RR_TREND_MIN: z.coerce.number().default(1.5),
  RR_WIDE_SPREAD_MIN: z.coerce.number().default(1.8),

  // Spread sampling on exit (observability)
  SPREAD_SAMPLE_ON_EXIT: z.string().default("true"),

  // Volatility→RR mapping (ATR% regime)
  VOL_ATR_PCT_LOW: z.coerce.number().default(0.35),
  VOL_ATR_PCT_HIGH: z.coerce.number().default(1.0),
  // Optimizer volatility bucket thresholds (in %)
  VOL_LOW_PCT: z.coerce.number().default(0.8),
  VOL_HIGH_PCT: z.coerce.number().default(2.0),
  RR_VOL_LOW: z.coerce.number().default(1.8),
  RR_VOL_MED: z.coerce.number().default(1.5),
  RR_VOL_HIGH: z.coerce.number().default(1.2),
  RR_MIN: z.coerce.number().default(1.1),
  RR_MAX: z.coerce.number().default(2.2),

  MONGO_URI: z.string().min(10),
  MONGO_DB: z.string().min(1),

  TOKENS_COLLECTION: z.string().default("broker_tokens"),
  TOKEN_FILTER_USER_ID: z.string().optional(),
  TOKEN_FILTER_API_KEY: z.string().optional(),
  TOKEN_FIELD: z.string().optional(),

  // Token polling (tokenWatcher)
  TOKEN_POLL_INTERVAL_MS: z.coerce.number().default(30000),

  KITE_API_KEY: z.string().min(3),
  KITE_API_SECRET: z.string().optional(),
  KITE_REDIRECT_SUCCESS_URL: z.string().optional(),
  KITE_ALLOWED_USER_ID: z.string().optional(),

  // PATCH-7: Quote guard (throttle + chunk + backoff + circuit breaker)
  QUOTE_GUARD_ENABLED: z.string().default("true"),
  QUOTE_GUARD_CHUNK_SIZE: z.coerce.number().default(75),
  QUOTE_GUARD_MAX_INFLIGHT: z.coerce.number().default(1),
  QUOTE_GUARD_MIN_INTERVAL_MS: z.coerce.number().default(150),
  QUOTE_GUARD_BUDGET_WINDOW_MS: z.coerce.number().default(10000),
  QUOTE_GUARD_BUDGET_MAX: z.coerce.number().default(20),
  QUOTE_GUARD_MAX_RETRIES: z.coerce.number().default(3),
  QUOTE_GUARD_BACKOFF_BASE_MS: z.coerce.number().default(250),
  QUOTE_GUARD_BACKOFF_MAX_MS: z.coerce.number().default(5000),
  QUOTE_GUARD_JITTER_PCT: z.coerce.number().default(0.25),
  QUOTE_GUARD_BREAKER_FAILS: z.coerce.number().default(4),
  QUOTE_GUARD_BREAKER_COOLDOWN_MS: z.coerce.number().default(20000),
  MARKET_HEALTH_GAP_MS: z.coerce.number().default(2000),

  SUBSCRIBE_TOKENS: z.string().optional(),
  SUBSCRIBE_SYMBOLS: z.string().optional(),

  // Strict symbol resolution: error if a symbol cannot be resolved
  STRICT_SUBSCRIBE_SYMBOLS: z.string().default("false"),

  // ===== F&O universe (Index FUT / OPT) =====
  FNO_ENABLED: z.string().default("false"),
  // FUT (index futures) or OPT (buy calls/puts)
  FNO_MODE: z.string().default("FUT"),
  // Pro mode: focus one underlying
  FNO_SINGLE_UNDERLYING_ENABLED: boolFromEnv.default(true),
  FNO_SINGLE_UNDERLYING_SYMBOL: z.string().default("NIFTY"),

  // e.g. NIFTY,BANKNIFTY,SENSEX
  FNO_UNDERLYINGS: z.string().default("NIFTY,BANKNIFTY,SENSEX"),
  // Exchanges to scan for derivative contracts
  FNO_EXCHANGES: z.string().default("NFO,BFO"),
  // If true, union SUBSCRIBE_SYMBOLS/TOKENS with F&O universe
  FNO_MERGE_CASH_UNIVERSE: z.string().default("false"),
  // STRICT blocks if sizing < 1 lot; FORCE_ONE_LOT forces 1 lot (risky)
  FNO_MIN_LOT_POLICY: z.string().default("STRICT"),
  // Log selected contracts at startup
  FNO_LOG_UNIVERSE: z.string().default("true"),
  // Avoid ultra-short DTE futures unless explicitly allowed
  FNO_MIN_DAYS_TO_EXPIRY: z.coerce.number().default(0),
  // e.g. "12:00" -> skip expiry-day futures entries after this time; unset disables
  FNO_AVOID_EXPIRY_DAY_AFTER: z.string().optional(),

  // Instrument dump cache TTL (seconds)
  INSTRUMENTS_DUMP_TTL_SEC: z.coerce.number().default(3600),

  // ===== Options (buy CE/PE) routing =====
  // Underlying source for signals in OPT mode: FUT or SPOT
  OPT_UNDERLYING_SOURCE: z.string().default("FUT"),
  // Underlying source for strike/ATM reference in OPT mode: SPOT (pro) or UNDERLYING
  OPT_STRIKE_REF_SOURCE: z.string().default("SPOT"),
  // Pick expiry: NEAREST (recommended)
  OPT_EXPIRY_POLICY: z.string().default("NEAREST"),
  // Expiry safety (optional)
  OPT_MIN_DAYS_TO_EXPIRY: z.coerce.number().default(1),
  // Preferred DTE band for option expiry selection (pro weekly-first behavior)
  OPT_ALLOW_ZERO_DTE: boolFromEnv.default(false),
  OPT_DTE_PREFER_MIN: z.coerce.number().default(1),
  OPT_DTE_PREFER_MAX: z.coerce.number().default(3),
  OPT_DTE_FALLBACK_MAX: z.coerce.number().default(7),
  // e.g. "14:30" -> avoid expiry-day entries after this time; unset disables
  OPT_AVOID_EXPIRY_DAY_AFTER: z.string().optional(),
  // ATM / ITM / OTM selection behavior
  OPT_MONEYNESS: z.string().default("ATM"),
  // Strike offset in steps (e.g. +1 = one step OTM for calls, -1 = one step ITM)
  OPT_STRIKE_OFFSET_STEPS: z.coerce.number().default(0),
  // Pro scalping: restrict to ATM ± scan steps only (no far strikes)
  OPT_STRICT_ATM_ONLY: boolFromEnv.default(true),
  // Hard reject if no candidate passes spread/depth/premium gates
  OPT_PICK_REQUIRE_OK: boolFromEnv.default(true),
  // Debug: attach the top-N option candidates to last pick metadata (0 disables). Max 10.
  OPT_PICK_DEBUG_TOP_N: z.coerce.number().default(0),
  OPT_ALTERNATE_CONTRACT_TOP_N: z.coerce.number().default(3),
  // Conservative confidence allowance used only for the pre-route fast reject.
  OPT_PRE_ROUTE_MAX_CONF_BOOST: z.coerce.number().default(14),

  // Strike step sizes (override if exchange changes lot/steps)
  OPT_STRIKE_STEP_NIFTY: z.coerce.number().default(50),
  OPT_STRIKE_STEP_BANKNIFTY: z.coerce.number().default(100),
  OPT_STRIKE_STEP_SENSEX: z.coerce.number().default(100),
  // Scan ±N strikes around ATM to find a liquid contract
  OPT_ATM_SCAN_STEPS: z.coerce.number().default(1),

  // Option-chain snapshot cache
  OPT_CHAIN_TTL_MS: z.coerce.number().default(1500),
  // Wider chain sampling around ATM (in strike steps)
  OPT_CHAIN_STRIKES_AROUND_ATM: z.coerce.number().default(10),

  // Back-compat aliases (older env names)
  OPT_STRIKE_OFFSET: z.coerce.number().default(0),
  OPT_STRIKE_SCAN_STEPS: z.coerce.number().default(2),

  // Liquidity / sanity
  OPT_MIN_PREMIUM: z.coerce.number().default(20),
  OPT_MAX_PREMIUM: z.coerce.number().default(600),
  // Underlying-specific premium bands (useful for small capital option buying)
  OPT_MIN_PREMIUM_NIFTY: z.coerce.number().default(80),
  OPT_MAX_PREMIUM_NIFTY: z.coerce.number().default(350),
  OPT_PREMIUM_BAND_ENFORCE_NIFTY: boolFromEnv.default(true),
  // Allow a premium-band-only fallback when all other gates pass (disabled by default).
  OPT_PREMIUM_BAND_FALLBACK: boolFromEnv.default(false),
  OPT_PREMIUM_BAND_FALLBACK_SLACK_DOWN: z.coerce.number().default(20),
  OPT_PREMIUM_BAND_FALLBACK_SLACK_UP: z.coerce.number().default(150),
  OPT_MAX_SPREAD_BPS: z.coerce.number().default(35),
  // Minimum depth (top of book qty) requirement; 0 disables
  OPT_MIN_DEPTH_QTY: z.coerce.number().default(0),
  // Candidate scoring weights (comma-separated k:v; keys: spread,dist,depth,volume,oi)
  OPT_PICK_SCORE_WEIGHTS: z.string().optional(),

  // Liquidity gate (spread/depth/OI/volume pre-filter)
  OPT_LIQ_GATE_ENABLED: boolFromEnv.default(true),
  OPT_LIQ_GATE_MIN_SCORE: z.coerce.number().default(45),
  OPT_LIQ_GATE_MAX_SPREAD_BPS: z.coerce.number().default(35),
  OPT_LIQ_GATE_MIN_DEPTH_QTY: z.coerce.number().default(0),
  OPT_LIQ_GATE_MIN_OI: z.coerce.number().default(0),
  OPT_LIQ_GATE_MIN_VOLUME: z.coerce.number().default(0),
  OPT_LIQ_GATE_TOP_N: z.coerce.number().default(0),

  // Strike selection behavior: ATM_OFFSET (legacy) or DELTA_NEAREST (delta-ish)
  OPT_STRIKE_SELECTION_MODE: z.string().default("DELTA_NEAREST"),

  // ---- Option-chain greeks / advanced filters ----
  GREEKS_REQUIRED: boolFromEnv.default(false),
  OPT_GREEKS_REQUIRED: boolFromEnv.default(false),
  OPT_RISK_FREE_RATE: z.coerce.number().default(0.06),

  // Delta band to avoid far OTM / low-reacting contracts (0..1)
  OPT_DELTA_BAND_ENFORCE: boolFromEnv.default(true),
  OPT_DELTA_BAND_MIN: z.coerce.number().default(0.35),
  OPT_DELTA_BAND_MAX: z.coerce.number().default(0.65),
  OPT_DELTA_TARGET: z.coerce.number().default(0.5),

  // IV gating in IV points (e.g., 20 = 20%)
  OPT_IV_NEUTRAL_PTS: z.coerce.number().default(20),
  OPT_IV_MAX_PTS: z.coerce.number().default(80),
  OPT_IV_DROP_BLOCK_PTS: z.coerce.number().default(2.0),

  // Spread trend gate (bps increase since previous snapshot)
  OPT_SPREAD_RISE_BLOCK_BPS: z.coerce.number().default(8),
  OPT_SPREAD_RISE_PENALTY_MULT: z.coerce.number().default(1.0),
  OPT_BOOK_FLICKER_BLOCK: z.coerce.number().default(4),
  OPT_HEALTH_SCORE_MIN: z.coerce.number().default(45),

  // Gamma gate near expiry
  OPT_GAMMA_MAX: z.coerce.number().default(0.004),
  OPT_GAMMA_GATE_DTE_DAYS: z.coerce.number().default(0.5),

  // OI wall context filter (support/resistance)
  OPT_OI_WALL_MULT: z.coerce.number().default(2.5),
  OPT_OI_WALL_STRIKES: z.coerce.number().default(2),
  OPT_OI_WALL_BLOCK: boolFromEnv.default(false),
  OPT_OI_WALL_REQUIRE_OI_CHANGE: boolFromEnv.default(true),

  // IV + theta edge gate (after plan) to avoid IV-crush traps
  OPT_IV_THETA_FILTER_ENABLED: boolFromEnv.default(true),
  OPT_IV_DROP_MIN_PTS: z.coerce.number().default(1.5),
  OPT_IV_DROP_CAP_PTS: z.coerce.number().default(4.0),
  OPT_EXPECTED_HOLD_MIN: z.coerce.number().default(10),
  OPT_IV_THETA_EDGE_MULT: z.coerce.number().default(1.2),

  // Stops for long options (premium-based)
  OPT_STOP_MODE: z.string().default("PCT"),
  // Option SL mode: PREMIUM_PCT (default) or UNDERLYING_ATR (delta/gamma aware)
  OPT_SL_MODE: z.string().default("PREMIUM_PCT"),
  OPT_SL_PCT: z.coerce.number().default(12),
  OPT_MAX_SL_PCT: z.coerce.number().default(35),
  OPT_MIN_SL_INR: z.coerce.number().default(0),
  // When OPT_SL_MODE=UNDERLYING_ATR, compute premium risk from underlying ATR * mult
  OPT_SL_UNDERLYING_ATR_MULT: z.coerce.number().default(1.0),
  OPT_SL_UNDERLYING_MIN_TICKS: z.coerce.number().default(6),

  // Option SL fitter (to make 1-lot risk fit RISK_PER_TRADE_INR caps when lot sizes are large)
  // If disabled, engine may block trades when 1-lot risk exceeds cap after lot-normalization.
  OPT_SL_FIT_ENABLED: boolFromEnv.default(false),
  // Current scope: only attempt pre-entry SL compression after the original strategy stop fails
  // the min-tradable risk-fit gate. Keep this opt-in so the engine blocks instead of over-
  // compressing strategy stops by default.
  OPT_SL_FIT_WHEN_CAP_BLOCKS: boolFromEnv.default(false),
  OPT_SL_FIT_MIN_DISTANCE_KEEP_PCT: z.coerce.number().default(80),
  PRE_ENTRY_SL_COMPRESSION_ENABLED: boolFromEnv.default(false),
  PRE_ENTRY_SL_COMPRESSION_MAX_PCT: z.coerce.number().default(0.10),
  PRE_ENTRY_SL_COMPRESSION_MAX_TICKS: z.coerce.number().default(6),
  PRE_ENTRY_SL_COMPRESSION_MAX_POINTS: z.coerce.number().optional(),
  PRE_ENTRY_SL_COMPRESSION_ALLOW_OPEN: boolFromEnv.default(false),
  PRE_ENTRY_SL_COMPRESSION_REQUIRE_RR_FLOOR: boolFromEnv.default(true),
  PRE_ENTRY_SL_COMPRESSION_MIN_RR: z.coerce.number().default(1.8),
  PRE_ENTRY_SL_COMPRESSION_MIN_KEEP_PCT: z.coerce.number().default(80),
  // Minimum SL distance enforced by fitter (in ticks). Helps avoid ultra-tight “0.05 SL” fitting.
  OPT_SL_FIT_MIN_TICKS: z.coerce.number().default(10),

  // PLAN/Options exits — premium-aware initial SL/TP (plan builder uses option candles when available)
  OPT_PLAN_PREMIUM_AWARE: boolFromEnv.default(true),
  OPT_PLAN_PREM_CANDLE_LIMIT: z.coerce.number().default(800),
  OPT_PLAN_PREM_ATR_PERIOD: z.coerce.number().default(14),
  OPT_PLAN_PREM_ATR_K: z.coerce.number().default(1.1),
  OPT_PLAN_PREM_ATR_M: z.coerce.number().default(1.8),

  // PATCH-4/Options exits — premium-based dynamic exit model (used by DynamicExitManager)
  OPT_EXIT_MODEL: z.string().default("PREMIUM_PCT"),
  OPT_EXIT_MAX_HOLD_MIN: z.coerce.number().default(25),
  OPT_EXIT_ALLOW_WIDEN_SL: z.string().default("true"),
  OPT_EXIT_WIDEN_WINDOW_MIN: z.coerce.number().default(2),
  OPT_EXIT_BASE_SL_PCT: z.coerce.number().default(18),
  OPT_EXIT_BASE_TARGET_PCT: z.coerce.number().default(35),
  OPT_EXIT_MIN_SL_PCT: z.coerce.number().default(8),
  OPT_EXIT_MAX_SL_PCT: z.coerce.number().default(35),
  OPT_EXIT_VOL_LOOKBACK: z.coerce.number().default(20),
  OPT_EXIT_VOL_REF_PCT: z.coerce.number().default(6),
  OPT_EXIT_WIDEN_FACTOR_MIN: z.coerce.number().default(0.75),
  OPT_EXIT_WIDEN_FACTOR_MAX: z.coerce.number().default(1.8),
  OPT_EXIT_TRAIL_START_PROFIT_PCT: z.coerce.number().default(15),
  OPT_EXIT_TRAIL_PCT_BASE: z.coerce.number().default(12),
  OPT_EXIT_TRAIL_PCT_MIN: z.coerce.number().default(6),
  OPT_EXIT_TRAIL_PCT_MAX: z.coerce.number().default(22),

  // Coarse IV spike/crush heuristics (proxy using underlying move)
  OPT_IV_NEUTRAL_BPS: z.coerce.number().default(12),
  OPT_IV_CRUSH_PREMIUM_PCT: z.coerce.number().default(18),
  OPT_IV_CRUSH_MIN_HOLD_MIN: z.coerce.number().default(3),
  OPT_IV_SPIKE_PREMIUM_PCT: z.coerce.number().default(25),
  OPT_IV_SPIKE_TRAIL_PCT: z.coerce.number().default(10),
  OPT_IV_SPIKE_TP_TO_BID: z.string().default("true"),
  OPT_IV_SPIKE_TP_BID_TICKS: z.coerce.number().default(1),

  // TradeManager/option routing knobs
  OPT_REQUIRE_SUBSCRIBED_LTP: z.string().default("false"),
  OPT_LTP_WARMUP_MS: z.coerce.number().default(1500),
  OPT_RUNTIME_SUBSCRIBE_BACKFILL: z.string().default("true"),
  OPT_DYN_EXIT_ALLOW_UNDERLYING_LTP_FETCH: z.string().default("false"),

  // Exit order placement for options: BROKER (default) or VIRTUAL (only SL + virtual target)
  OPT_TARGET_MODE: z.string().default("BROKER"),

  // Virtual target (margin-blocked target fallback)
  VIRTUAL_TARGET_LTP_FETCH_ENABLED: z.string().default("true"),
  VIRTUAL_TARGET_LTP_FETCH_THROTTLE_MS: z.coerce.number().default(1500),

  // Risk fail-safe controls
  RESET_FAILURES_ON_START: z.string().default("false"),

  CANDLE_INTERVALS: z.string().default("1,3"),
  CANDLE_COLLECTION_PREFIX: z.string().default("candles_"),
  CANDLE_TZ: z.string().default("Asia/Kolkata"),
  // Optional tick-based signal confirmation (intra-candle)
  SIGNAL_TICK_CONFIRM_ENABLED: z.string().default("false"),
  SIGNAL_TICK_CONFIRM_THROTTLE_MS: z.coerce.number().default(1500),
  SIGNAL_TICK_CONFIRM_SUPPRESS_CLOSE: z.string().default("true"),
  MARKET_OPEN: z.string().default("09:15"),
  MARKET_CLOSE: z.string().default("15:30"),
  MARKET_GATE_POLL_MS: z.coerce.number().default(5000),
  MARKET_GATE_CONTROL_TRADING: z.string().default("true"),
  ENGINE_LIFECYCLE_ENABLED: z.string().default("false"),
  ENGINE_LIFECYCLE_NOTIFY_ENABLED: z.string().default("true"),
  ENGINE_WARMUP_HHMM: z.string().default("09:10"),
  ENGINE_LIVE_HHMM: z.string().default("09:15"),
  ENGINE_CLOSE_HHMM: z.string().default("15:30"),
  ENGINE_IDLE_AFTER_MIN: z.coerce.number().default(5),
  ENGINE_COOLDOWN_POLL_SEC: z.coerce.number().default(15),
  ENGINE_REQUIRE_FLAT_BEFORE_IDLE: z.string().default("true"),
  ENGINE_TEST_NOW_ISO: z.string().optional(),
  TICK_WATCHDOG_ENABLED: z.string().default("true"),
  TICK_WATCHDOG_INTERVAL_MS: z.coerce.number().default(5000),
  TICK_WATCHDOG_MAX_AGE_MS: z.coerce.number().default(15000),
  TICK_TAP_LOG: z.string().default("false"),

  // Market holiday calendar (optional) — blocks trading on holidays / weekends and supports special sessions.
  HOLIDAY_CALENDAR_ENABLED: z.string().default("false"),
  HOLIDAY_CALENDAR_FILE: z.string().default("config/market_calendar.json"),
  HOLIDAY_CALENDAR_LOG: z.string().default("true"),
  // If true, calendar special_sessions can override open/close (e.g., Muhurat trading).
  SPECIAL_SESSIONS_ENABLED: z.string().default("false"),
  BACKFILL_DAYS: z.coerce.number().default(3),

  // PATCH-9: Candle retention / TTL indexes (DB growth control)
  // Enable to automatically create TTL indexes on candle collections (candles_*).
  // NOTE: TTL will DELETE old candle documents beyond retention window.
  CANDLE_TTL_ENABLED: z.string().default("false"),
  // Default retention (days) for intervals not specified in CANDLE_TTL_MAP
  CANDLE_TTL_DEFAULT_DAYS: z.coerce.number().default(90),
  // Per-interval retention map (days). Format: "1:30,3:60,5:90"
  CANDLE_TTL_MAP: z.string().default("1:30,3:60,5:90"),
  CANDLE_TTL_LOG: z.string().default("true"),
  // Ensure TTL indexes at startup (recommended)
  RETENTION_ENSURE_ON_START: z.string().default("true"),

  // Admin DB purge (dangerous; deletes all docs except keep list)
  DB_PURGE_ENABLED: z.string().default("false"),
  // Comma-separated collections to keep when purging (e.g., "audit_logs,broker_tokens")
  DB_PURGE_KEEP_COLLECTIONS: z.string().default("audit_logs"),

  // Production hardening
  RECONCILE_INTERVAL_SEC: z.coerce.number().default(60),
  TICK_QUEUE_MAX: z.coerce.number().default(50),
  // Tick mode controls (reduce load). Used by kite/tickerManager.
  // Values:
  // - 'ltp'   : last_price only (no volume / ohlc / depth) — NOT recommended for volume-based confidence.
  // - 'quote' : ltp + day volume + ohlc (recommended for underlying)
  // - 'full'  : quote + depth (recommended for traded/exit tokens)
  TICK_MODE_DEFAULT: z.string().default("full"),
  TICK_MODE_TRADE: z.string().default("full"),
  TICK_MODE_UNDERLYING: z.string().default("quote"),
  TICK_MODE_OPTIONS: z.string().default("quote"),

  // Candle write buffer (avoid DB writes in the hot tick loop). Only used if market/candleWriteBuffer exists.
  CANDLE_WRITE_BUFFER_ENABLED: boolFromEnv.default(true),
  CANDLE_WRITE_BATCH_SIZE: z.coerce.number().default(200),
  CANDLE_WRITE_FLUSH_MS: z.coerce.number().default(250),
  CANDLE_WRITE_MAX_BATCH: z.coerce.number().default(500),
  CANDLE_WRITE_MAX_BUFFER: z.coerce.number().default(15000),
  CANDLE_WRITE_LOG: z.string().default("false"),
  // Persist candles for non-signal tokens (e.g., option instruments) if enabled.
  CANDLE_PERSIST_NON_SIGNAL_TOKENS: z.string().default("false"),
  DAILY_LOSS_CHECK_MS: z.coerce.number().default(2000),
  FORCE_FLATTEN_CHECK_MS: z.coerce.number().default(1000),
  // Allow REST quote fetch for LTP in daily-loss checker when ticks are sparse
  DAILY_LOSS_ALLOW_LTP_FETCH: z.string().default("true"),

  // PATCH-3: Recovery safety — always (re)subscribe any broker-side open position tokens
  // after restarts / reconnects so risk + exits keep receiving LTP and candles.
  POSITION_RESUBSCRIBE_ENABLED: z.string().default("true"),
  POSITION_RESUBSCRIBE_ON_RECONNECT: z.string().default("true"),
  POSITION_RESUBSCRIBE_UNDERLYING: z.string().default("true"),
  POSITION_RESUBSCRIBE_BACKFILL: z.string().default("true"),
  POSITION_RESUBSCRIBE_MIN_INTERVAL_SEC: z.coerce.number().default(30),
  POSITION_RESUBSCRIBE_RESPECT_PRODUCT: z.string().default("false"),
  // Back-compat alias (older name used in some modules)
  POSITION_RESUBSCRIBE_PRODUCT_STRICT: z.string().default("false"),
  POSITION_RESUBSCRIBE_UNDERLYING_REBUILD_COOLDOWN_SEC: z.coerce
    .number()
    .default(300),

  // Runtime subscribe (used for OPT mode: subscribe selected option token on-demand)
  RUNTIME_SUBSCRIBE_ENABLED: z.string().default("true"),
  RUNTIME_SUBSCRIBE_BACKFILL: z.string().default("true"),
  RUNTIME_SUBSCRIBE_BACKFILL_DAYS: z.coerce.number().default(1),
  // Option-specific days override (used when subscribing option token)
  RUNTIME_SUBSCRIBE_BACKFILL_DAYS_OPT: z.coerce.number().default(2),

  CANDLE_TIMER_FINALIZER_ENABLED: z.string().default("true"),
  CANDLE_FINALIZER_INTERVAL_MS: z.coerce.number().default(1000),
  CANDLE_FINALIZE_GRACE_MS: z.coerce.number().default(1500),
  CANDLE_FINALIZE_MAX_BARS_PER_RUN: z.coerce.number().default(3),
  CANDLE_CACHE_MAX: z.coerce.number().default(800),
  CANDLE_CACHE_LIMIT: z.coerce.number().default(400),

  ALLOW_SYNTHETIC_SIGNALS: z.string().default("false"),

  TRADING_ENABLED: z.string().default("false"),
  DEFAULT_EXCHANGE: z.string().default("NSE"),
  DEFAULT_PRODUCT: z.string().default("MIS"),
  DEFAULT_ORDER_VARIETY: z.string().default("regular"),

  // Optional broker-side market protection for MARKET/SL-M orders.
  // Set to "-1" (auto) or a percent like "0.5". Leave empty to disable.
  ENFORCE_MARKET_PROTECTION: z.string().default("true"),
  MARKET_PROTECTION: z.string().default("-1"),
  // Stop-loss order type controls
  // NOTE: Many F&O segments disallow SL-M, so default for derivatives is SL (stoploss-limit).
  STOPLOSS_ORDER_TYPE_EQ: z.string().default("SL-M"), // equities (NSE cash etc.)
  STOPLOSS_ORDER_TYPE_FO: z.string().default("SL"), // derivatives (NFO/BFO/CDS/MCX etc.)

  // If STOPLOSS_ORDER_TYPE_* is "SL", we must provide a LIMIT price.
  // We set it near the trigger to behave like SL-M without violating execution ranges.
  // Buffer = max(trigger * SL_LIMIT_BUFFER_BPS/10000, tick_size * SL_LIMIT_BUFFER_TICKS, SL_LIMIT_BUFFER_ABS)
  SL_LIMIT_BUFFER_BPS: z.coerce.number().default(50), // 50 bps = 0.50%
  SL_LIMIT_BUFFER_TICKS: z.coerce.number().default(10), // minimum buffer in ticks
  SL_LIMIT_BUFFER_ABS: z.coerce.number().default(0), // absolute ₹ buffer (optional)
  SL_LIMIT_BUFFER_MAX_BPS: z.coerce.number().default(500), // cap buffer at 5%

  // Panic-exit fallback: if SL trigger is missed, place a stoploss-limit exit near LTP
  PANIC_EXIT_LIMIT_FALLBACK_ENABLED: z.string().default("true"),
  PANIC_EXIT_LIMIT_BUFFER_TICKS: z.coerce.number().default(2),
  PANIC_EXIT_LIMIT_MAX_BPS: z.coerce.number().default(250),
  SL_SAFETY_SLA_MS: z.coerce.number().default(3000),
  SL_SLA_BREACH_COOLDOWN_MIN: z.coerce.number().default(5),
  // Panic-exit fill SLA: if PANIC_EXIT stays open, cancel + replace.
  PANIC_EXIT_FILL_TIMEOUT_MS: z.coerce.number().default(2500),
  PANIC_EXIT_MAX_RETRIES: z.coerce.number().default(1),

  MAX_ENTRY_SLIPPAGE_BPS: z.coerce.number().default(25),
  MAX_ENTRY_SLIPPAGE_KILL_BPS: z.coerce.number().default(60),

  // Patch: segment-aware slippage guard (options are noisier / wider spreads)
  ENTRY_SLIPPAGE_GUARD_FOR_LIMIT: z.string().default("false"),
  MAX_ENTRY_SLIPPAGE_BPS_OPT: z.coerce.number().default(120),
  MAX_ENTRY_SLIPPAGE_KILL_BPS_OPT: z.coerce.number().default(250),
  // Minimum tolerance (in ticks) to prevent false panic-exits due to rounding / tick jumps
  MAX_ENTRY_SLIPPAGE_TICKS: z.coerce.number().default(2),
  MAX_ENTRY_SLIPPAGE_TICKS_OPT: z.coerce.number().default(4),

  // Risk limits
  RISK_PER_TRADE_INR: z.coerce.number().default(450),
  DAILY_PROFIT_GOAL_INR: z.coerce.number().default(2000),

  // Exit management (min-green, breakeven lock, trailing, time stop)
  MIN_GREEN_ENABLED: z.string().default("true"),
  MIN_GREEN_SLIPPAGE_PTS_OPT: z.coerce.number().default(2),
  BE_LOCK_AT_PROFIT_INR: z.coerce.number().default(200),
  BE_ARM_R: z.coerce.number().default(0.6),
  TRAIL_ARM_R: z.coerce.number().default(1.0),
  GREEN_LOCK_ENABLED: z.string().default("true"),
  GREEN_LOCK_ARM_R: z.coerce.number().default(0.8),
  GREEN_LOCK_PEAK_R: z.coerce.number().default(1.0),
  GREEN_LOCK_MIN_R: z.coerce.number().default(0.12),
  GREEN_LOCK_COST_MULT: z.coerce.number().default(1.0),
  MFE_LOCK_LADDER_ENABLED: z.string().default("true"),
  EXIT_TIGHTEN_AT_R: z.coerce.number().default(1.0),
  // Optional weak-regime governor: keep post-1R tighten inactive in choppy/range regimes.
  EXIT_TIGHTEN_WEAK_REGIME_GOVERNOR_ENABLED: boolFromEnv.default(true),
  EXIT_TIGHTEN_WEAK_REGIMES: z.string().default("RANGE,CHOP,WEAK"),
  EXIT_POST_1R_TRAIL_GAP_R: z.coerce.number().default(0.25),
  EXIT_MFE_LOCK_T1_R: z.coerce.number().default(0.8),
  EXIT_MFE_LOCK_T1_KEEP_R: z.coerce.number().default(0.2),
  EXIT_MFE_LOCK_T2_R: z.coerce.number().default(1.0),
  EXIT_MFE_LOCK_T2_KEEP_R: z.coerce.number().default(0.6),
  EXIT_MFE_LOCK_T3_R: z.coerce.number().default(1.25),
  EXIT_MFE_LOCK_T3_KEEP_R: z.coerce.number().default(0.8),
  EXIT_MFE_LOCK_T4_R: z.coerce.number().default(1.5),
  EXIT_MFE_LOCK_T4_KEEP_R: z.coerce.number().default(1.0),
  EXIT_MFE_LOCK_T5_R: z.coerce.number().default(2.0),
  EXIT_MFE_LOCK_T5_GIVEBACK_R: z.coerce.number().default(0.4),
  EXIT_MFE_LOCK_T5_MIN_KEEP_R: z.coerce.number().default(1.2),
  MFE_LOCK_1_AT_R: z.coerce.number().default(1.0),
  MFE_LOCK_1_KEEP_R: z.coerce.number().default(0.2),
  MFE_LOCK_2_AT_R: z.coerce.number().default(1.4),
  MFE_LOCK_2_KEEP_R: z.coerce.number().default(0.45),
  MFE_LOCK_3_AT_R: z.coerce.number().default(1.8),
  MFE_LOCK_3_KEEP_R: z.coerce.number().default(0.75),
  MFE_LOCK_4_AT_R: z.coerce.number().default(2.4),
  MFE_LOCK_4_KEEP_R: z.coerce.number().default(1.1),
  MFE_LOCK_5_AT_R: z.coerce.number().default(3.0),
  MFE_LOCK_5_KEEP_R: z.coerce.number().default(1.5),
  EXIT_HARD_GIVEBACK_T1_PEAK_R: z.coerce.number().default(1.0),
  EXIT_HARD_GIVEBACK_T1_R: z.coerce.number().default(0.3),
  EXIT_HARD_GIVEBACK_T2_PEAK_R: z.coerce.number().default(1.25),
  EXIT_HARD_GIVEBACK_T2_R: z.coerce.number().default(0.35),
  EXIT_HARD_GIVEBACK_T3_PEAK_R: z.coerce.number().default(1.5),
  EXIT_HARD_GIVEBACK_T3_PCT: z.coerce.number().default(0.3),
  EXIT_HARD_GIVEBACK_CONFIRM_MS: z.coerce.number().default(800),
  EXIT_HARD_GIVEBACK_CONFIRM_TICKS: z.coerce.number().default(2),
  BE_BUFFER_TICKS: z.coerce.number().default(1),
  TRIGGER_BUFFER_TICKS: z.coerce.number().default(1),
  DYNAMIC_EXIT_REQUIRE_WINNER_GATE_FOR_STRUCTURE_TRAIL:
    boolFromEnv.default(true),
  // Deprecated: retained for env compatibility; live trailing uses TRAIL_GAP_*_PCT/MIN/MAX knobs.
  TRAIL_GAP_PREMIUM_POINTS: z.coerce.number().default(8),
  TRAIL_GAP_PRE_BE_PCT: z.coerce.number().default(0.08),
  TRAIL_GAP_POST_BE_PCT: z.coerce.number().default(0.04),
  TRAIL_GAP_POST_BE_PCT_TIGHT: z.coerce.number().default(0.03),
  TRAIL_GAP_MIN_PTS: z.coerce.number().default(2),
  TRAIL_GAP_MAX_PTS: z.coerce.number().default(10),
  TRAIL_TIGHTEN_R: z.coerce.number().default(1.5),
  TIME_STOP_MIN: z.coerce.number().default(5),
  TIME_STOP_NO_PROGRESS_MIN: z.coerce.number().default(0),
  TIME_STOP_NO_PROGRESS_MFE_R: z.coerce.number().default(0.2),
  TIME_STOP_NO_PROGRESS_REQUIRE_UL_CONFIRM: z.string().default("true"),
  TIME_STOP_NO_PROGRESS_UL_BPS: z.coerce.number().default(12),
  TIME_STOP_NO_PROGRESS_UNDERLYING_CONFIRM: z.string().default("false"),
  TIME_STOP_NO_PROGRESS_UNDERLYING_MFE_BPS: z.coerce.number().default(8),
  TIME_STOP_NO_PROGRESS_UNDERLYING_STRICT_DATA: z.string().default("false"),
  TIME_STOP_MAX_HOLD_MIN: z.coerce.number().default(0),
  TIME_STOP_MAX_HOLD_SKIP_IF_PNL_R: z.coerce.number().default(0.8),
  TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_R: z.coerce.number().default(1.0),
  TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_PNL_R: z.coerce.number().default(1.0),
  TIME_STOP_MAX_HOLD_SKIP_IF_LOCKED: z.string().default("true"),
  TIME_STOP_EXIT_POLICY: z.string().default("SMART"),
  TIME_STOP_EXIT_LIMIT_BUFFER_TICKS: z.coerce.number().default(2),
  TIME_STOP_EXIT_LIMIT_MAX_BPS: z.coerce.number().default(200),
  TIME_STOP_EXIT_PREFER_LIMIT: z.string().default("true"),
  TIME_STOP_EXIT_ALLOW_MARKET_FALLBACK: z.string().default("true"),
  TIME_STOP_EXIT_MARKET_MAX_SPREAD_BPS: z.coerce.number().default(45),
  TIME_STOP_LATCH_MIN: z.coerce.number().default(3),
  TIME_STOP_ALERT_DEDUP_MIN: z.coerce.number().default(10),
  TIME_STOP_LATCH_ESCALATE_COOLDOWN_MS: z.coerce.number().default(8000),
  PROFIT_LOCK_ENABLED: z.string().default("false"),
  PROFIT_LOCK_R: z.coerce.number().default(1.0),
  PROFIT_LOCK_KEEP_R: z.coerce.number().default(0.25),
  PROFIT_LOCK_MIN_INR: z.coerce.number().default(0),
  EXIT_LOOP_MS: z.coerce.number().default(1500),
  STALE_TICK_MS: z.coerce.number().default(3000),

  // Disable TP orders (SL-only mode)
  OPT_TP_ENABLED: z.string().default("false"),

  // Post-fill risk recheck (fills can drift; classify/tag/exit without rewriting strategy stop)
  POST_FILL_RISK_RECHECK_ENABLED: boolFromEnv.default(true),
  // extra tolerance over the cap (e.g., 0.01 = +1%)
  POST_FILL_RISK_EPS_PCT: z.coerce.number().default(0.01),
  // Legacy fallback key. Hard breach policy now prefers POST_FILL_RISK_HARD_ACTION.
  POST_FILL_RISK_FAIL_ACTION: z.string().default("EXIT"),
  // Legacy compatibility only; post-fill SL refit is no longer used by default.
  POST_FILL_RISK_REFIT_TARGET: boolFromEnv.default(true),
  // Legacy compatibility only; post-fill SL refit is no longer used by default.
  POST_FILL_RISK_MIN_TICKS: z.coerce.number().default(2),

  // PATCH-5: Lot risk cap enforcement (post lot-normalization)
  LOT_RISK_CAP_ENFORCE: boolFromEnv.default(true),
  LOT_RISK_CAP_APPLY_IN_MARGIN_MODE: z.string().default("true"),
  // Tolerance to avoid micro blocks due to rounding (e.g., 0.02 = 2%)
  LOT_RISK_CAP_EPS_PCT: z.coerce.number().default(0.02),
  MAX_TRADES_PER_DAY: z.coerce.number().default(5),
  MAX_OPEN_POSITIONS: z.coerce.number().default(1),
  SYMBOL_COOLDOWN_SECONDS: z.coerce.number().default(180),
  SYMBOL_COOLDOWN_AFTER_SL_SEC: z.coerce.number().default(300),
  SYMBOL_COOLDOWN_AFTER_TIME_STOP_SEC: z.coerce.number().default(180),
  SYMBOL_COOLDOWN_AFTER_PROFIT_SEC: z.coerce.number().default(60),
  SYMBOL_COOLDOWN_DEFAULT_SEC: z.coerce.number().default(180),
  DAILY_MAX_LOSS_INR: z.coerce.number().default(1350),
  AUTO_EXIT_ON_DAILY_LOSS: z.string().default("true"),
  RISK_MAX_DRAWDOWN_INR: z.coerce.number().default(2700),
  RISK_MAX_EXPOSURE_PER_SYMBOL_INR: z.coerce.number().default(150000),
  RISK_MAX_PORTFOLIO_EXPOSURE_INR: z.coerce.number().default(0),
  RISK_MAX_LEVERAGE: z.coerce.number().default(0),

  // Trading window (MIS safe)
  AUTO_FIX_TIME_WINDOWS: z.string().default("false"),
  STOP_NEW_ENTRIES_AFTER: z.string().default("15:00"), // HH:mm in CANDLE_TZ
  FORCE_FLATTEN_AT: z.string().default("15:20"), // HH:mm in CANDLE_TZ
  EOD_MIS_TO_NRML_ENABLED: boolFromEnv.default(true),
  EOD_MIS_TO_NRML_AT: z.string().default("15:18"), // HH:mm in CANDLE_TZ (must be < FORCE_FLATTEN_AT)
  EOD_CARRY_ALLOWED: boolFromEnv.default(false),
  RECONCILE_BROKER_SQOFF_MATCH_WINDOW_SEC: z.coerce.number().default(300),

  // Additional no-trade windows: comma-separated "HH:mm-HH:mm" ranges
  // Example: "09:15-09:25,15:20-15:30"
  NO_TRADE_WINDOWS: z.string().optional(),

  // Reliability guards
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().default(3),

  // Order rate limits (soft guard; tune per account)
  MAX_ORDERS_PER_SEC: z.coerce.number().default(10),
  MAX_ORDERS_PER_MIN: z.coerce.number().default(200),
  MAX_ORDERS_PER_DAY: z.coerce.number().default(3000),

  // Safe placement retry (only for retryable transport errors and only after de-dup check)
  ORDER_PLACE_RETRY_MAX: z.coerce.number().default(1),
  ORDER_PLACE_RETRY_BACKOFF_MS: z.coerce.number().default(250),
  ORDER_DEDUP_LOOKBACK_SEC: z.coerce.number().default(120),

  // Entry verification (limit entry fill watchdog)
  ENTRY_WATCH_POLL_MS: z.coerce.number().default(1000),
  ENTRY_WATCH_MS: z.coerce.number().default(30000),
  CANCEL_ENTRY_ON_TIMEOUT: z.string().default("true"),
  ENTRY_TIMEOUT_LATE_FILL_ATTEMPTS: z.coerce.number().default(2),
  ENTRY_TIMEOUT_LATE_FILL_DELAY_MS: z.coerce.number().default(400),

  // Exit leg verification
  EXIT_WATCH_POLL_MS: z.coerce.number().default(1000),
  EXIT_WATCH_MS: z.coerce.number().default(20000),
  TARGET_REPLACE_MAX: z.coerce.number().default(2),
  // OCO reconciliation
  OCO_POSITION_RECONCILER_ENABLED: z.string().default("true"),
  OCO_RECONCILE_INTERVAL_SEC: z.coerce.number().default(5),
  OCO_RECENT_CLOSED_WINDOW_SEC: z.coerce.number().default(120),
  // Orphan order-update replay
  ORPHAN_REPLAY_DELAY_MS: z.coerce.number().default(250),
  ORPHAN_REPLAY_MAX_ATTEMPTS: z.coerce.number().default(4),
  ORPHAN_REPLAY_BACKOFF_FACTOR: z.coerce.number().default(2),
  ORPHAN_REPLAY_BACKOFF_MAX_MS: z.coerce.number().default(10_000),
  ORPHAN_REPLAY_JITTER_PCT: z.coerce.number().default(0.15),
  ORPHAN_REPLAY_DEAD_LETTER_ENABLED: boolFromEnv.default(true),

  // SL fill watchdog: protects SL-L (stoploss-limit) from staying OPEN after trigger in fast moves.
  SL_WATCHDOG_ENABLED: boolFromEnv.default(true),
  // If SL is triggered (LTP crosses trigger) but the SL order stays OPEN beyond this window -> cancel & MARKET exit.
  SL_WATCHDOG_OPEN_SEC: z.coerce.number().default(8),
  // Poll cadence while waiting (ms). Uses ticks when available; may fall back to a throttled quote/LTP fetch.
  SL_WATCHDOG_POLL_MS: z.coerce.number().default(900),
  // Extra trigger buffer (in bps) to reduce false positives around the exact trigger price.
  SL_WATCHDOG_TRIGGER_BPS_BUFFER: z.coerce.number().default(5),
  // Require a price breach (via ticks/LTP) before considering the SL "triggered".
  SL_WATCHDOG_REQUIRE_LTP_BREACH: boolFromEnv.default(true),
  // If true, enable kill-switch when watchdog fires (safest). If false, only panic-exits the position.
  SL_WATCHDOG_KILL_SWITCH_ON_FIRE: boolFromEnv.default(false),

  // Health / monitoring (used by /admin/health/critical)
  CRITICAL_HEALTH_REQUIRE_TICKER_CONNECTED: boolFromEnv.default(true),
  CRITICAL_HEALTH_FAIL_ON_HALT: boolFromEnv.default(true),
  CRITICAL_HEALTH_FAIL_ON_QUOTE_BREAKER: boolFromEnv.default(false),
  CRITICAL_HEALTH_FAIL_ON_KILL_SWITCH: boolFromEnv.default(false),
  // Grace window for quote breaker (ms). 0 means fail immediately when breaker is open.
  CRITICAL_HEALTH_QUOTE_BREAKER_GRACE_MS: z.coerce.number().default(0),

  // Telegram alerts (optional)
  TELEGRAM_ENABLED: z.string().default("false"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_MIN_LEVEL: z.string().default("info"), // info|warn|error
  TELEGRAM_DETAILED: z.string().default("true"),
  TELEGRAM_MAX_META_CHARS: z.coerce.number().default(1500),
  TELEGRAM_PARSE_MODE: z.string().default("HTML"),

  STRATEGY_ID: z.string().default("ema_cross"),

  // Strategy selection
  STRATEGIES: z
    .string()
    .default(
      "ema_pullback,vwap_reclaim,orb,bb_squeeze,breakout,volume_spike,fakeout,rsi_fade,wick_reversal",
    ),
  SIGNAL_INTERVALS: z.string().default("1"),
  SIGNAL_STATE_PERSIST: z.string().default("false"),
  SIGNAL_STATE_PERSIST_PATH: z.string().optional(),
  SIGNAL_STATE_PERSIST_TTL_MIN: z.coerce.number().default(180),
  SIGNAL_STATE_PERSIST_MAX_SETUPS: z.coerce.number().default(2500),

  STRATEGY_SELECTOR_ENABLED: z.string().default("false"),
  STRATEGIES_TREND: z.string().optional(),
  STRATEGIES_RANGE: z.string().optional(),
  STRATEGIES_OPEN: z.string().optional(),
  STRATEGIES_ALWAYS: z.string().optional(),

  SELECTOR_OPEN_WINDOW_MIN: z.coerce.number().default(20),
  SELECTOR_FAST_EMA: z.coerce.number().default(9),
  SELECTOR_SLOW_EMA: z.coerce.number().default(21),
  SELECTOR_RANGE_LOOKBACK: z.coerce.number().default(30),
  SELECTOR_ATR_PERIOD: z.coerce.number().default(14),
  SELECTOR_TREND_DIFF_ATR: z.coerce.number().default(0.6),
  SELECTOR_RANGE_PCT_MAX: z.coerce.number().default(0.012),
  SELECTOR_RANGE_DIFF_ATR_MAX: z.coerce.number().default(0.25),
  SELECTOR_VWAP_LOOKBACK: z.coerce.number().default(120),

  // Strategy tuning (optional)
  PULLBACK_VOL_LOOKBACK: z.coerce.number().default(20),
  PULLBACK_VOL_MULT: z.coerce.number().default(1.1),

  PULLBACK_BARS: z.coerce.number().default(5),

  BREAKOUT_LOOKBACK: z.coerce.number().default(20),
  BREAKOUT_VOL_MULT: z.coerce.number().default(1.2),

  VWAP_LOOKBACK: z.coerce.number().default(120),
  VWAP_VOL_MULT: z.coerce.number().default(1.0),
  ORB_MINUTES: z.coerce.number().default(15),
  ORB_VOL_MULT: z.coerce.number().default(1.2),

  // Volume spike strategy
  VOL_SPIKE_LOOKBACK: z.coerce.number().default(20),
  VOL_SPIKE_MULT: z.coerce.number().default(2),

  BB_PERIOD: z.coerce.number().default(20),
  BB_STD: z.coerce.number().default(2),
  // Back-compat alias (some modules use BB_STDDEV)
  BB_STDDEV: z.coerce.number().default(2),
  BB_SQUEEZE_PCT: z.coerce.number().default(0.012),
  BB_SQUEEZE_VOL_MULT: z.coerce.number().default(1.1),

  // Back-compat aliases (some modules use SQUEEZE_*)
  SQUEEZE_PCT: z.coerce.number().default(0.012),
  SQUEEZE_VOL_MULT: z.coerce.number().default(1.1),

  RSI_PERIOD: z.coerce.number().default(14),
  RSI_OB: z.coerce.number().default(70),
  RSI_OS: z.coerce.number().default(30),

  // Back-compat aliases (some modules use RSI_OVERBOUGHT/RSI_OVERSOLD)
  RSI_OVERBOUGHT: z.coerce.number().default(70),
  RSI_OVERSOLD: z.coerce.number().default(30),

  MOM_VOL_MULT: z.coerce.number().default(1.6),
  MOM_BODY_FRAC: z.coerce.number().default(0.6),

  FAKEOUT_LOOKBACK: z.coerce.number().default(20),
  FAKEOUT_VOL_LOOKBACK: z.coerce.number().default(20),
  FAKEOUT_VOL_MULT: z.coerce.number().default(1.0),

  FAKEOUT_WICK_FRAC: z.coerce.number().default(0.6),
  FAKEOUT_MIN_RANGE_FRAC: z.coerce.number().default(0.004),

  WICK_LOOKBACK: z.coerce.number().default(20),
  WICK_MIN_WICK_FRAC: z.coerce.number().default(0.6),
  EMA_FAST: z.coerce.number().default(9),
  EMA_SLOW: z.coerce.number().default(21),
  RR_TARGET: z.coerce.number().default(1.0),
  RUNNER_MIN_TARGET_BPS: z.coerce.number().default(0),
  SL_PCT_FALLBACK: z.coerce.number().default(0.3),

  USE_MARGIN_SIZING: z.string().default("true"),
  MARGIN_BUFFER_PCT: z.coerce.number().default(5),
  MARGIN_ALLOW_ESTIMATED_ORDER_MARGIN: boolFromEnv.default(false),

  // Position sizing mode:
  // - RISK_THEN_MARGIN (default): size by RISK_PER_TRADE_INR then downsize if margin is insufficient
  // - MARGIN: size purely from available margin (subject to caps)
  // - RISK: size purely from risk (set USE_MARGIN_SIZING=false if you never want margin checks)
  QTY_SIZING_MODE: z.string().default("RISK_THEN_MARGIN"),
  // Use only this % of available margin for sizing (extra safety); 100 = use all available (minus buffer)
  MARGIN_USE_PCT: z.coerce.number().default(100),
  // Absolute safety cap even when sizing from margin (prevents huge qty on low-priced stocks)
  MAX_QTY_HARDCAP: z.coerce.number().default(10000),

  // Signal quality / regime filters (real-money recommended)
  REGIME_FILTERS_ENABLED: z.string().default("true"),
  MULTI_TF_ENABLED: z.string().default("true"),
  MULTI_TF_MODE: z.string().default("TREND_ONLY"), // ALL | TREND_ONLY | OFF
  MULTI_TF_INTERVAL_MIN: z.coerce.number().default(5),
  MULTI_TF_EMA_FAST: z.coerce.number().default(9),
  MULTI_TF_EMA_SLOW: z.coerce.number().default(21),

  // Lookback caps (prevents heavy DB reads)
  MTF_LOOKBACK_LIMIT: z.coerce.number().default(200),
  ATR_LOOKBACK_LIMIT: z.coerce.number().default(200),

  ENABLE_SPREAD_FILTER: z.string().default("false"),
  MAX_SPREAD_BPS: z.coerce.number().default(15),
  // Segment-specific spread caps (optional). If unset, MAX_SPREAD_BPS (or OPT_MAX_SPREAD_BPS for options) is used.
  MAX_SPREAD_BPS_EQ: z.coerce.number().optional(),
  MAX_SPREAD_BPS_FUT: z.coerce.number().optional(),
  MAX_SPREAD_BPS_OPT: z.coerce.number().optional(),

  ENABLE_REL_VOLUME_FILTER: z.string().default("true"),
  // Strategy-aware thresholds (optional). If unset, engine falls back to MIN_REL_VOLUME.
  MIN_REL_VOLUME_TREND: z.coerce.number().optional(),
  MIN_REL_VOLUME_RANGE: z.coerce.number().optional(),
  MIN_REL_VOLUME_OPEN: z.coerce.number().optional(),

  // Strategy style vs regime alignment (tunable; defaults are safe/pro-like)
  STRATEGY_STYLE_REGIME_GATES_ENABLED: z.string().default("true"),
  TREND_ALLOWED_REGIMES: z.string().default("TREND,OPEN"),
  RANGE_ALLOWED_REGIMES: z.string().default("RANGE,OPEN"),
  OPEN_ALLOWED_REGIMES: z.string().default("OPEN,TREND"),

  // Mean-reversion safety (optional): block RANGE strategies when higher-TF trend is strong
  RANGE_AVOID_TREND: z.string().default("false"),
  RANGE_MAX_TREND_STRENGTH_BPS: z.coerce.number().default(40),
  MIN_REL_VOLUME: z.coerce.number().default(1.0),

  ENABLE_VOLATILITY_FILTER: z.string().default("true"),
  MIN_ATR_PCT: z.coerce.number().default(0.05), // % of price
  MAX_ATR_PCT: z.coerce.number().default(2.5),

  ENABLE_RANGE_PCTL_FILTER: z.string().default("false"),
  RANGE_PCTL_LOOKBACK: z.coerce.number().default(50),
  MIN_RANGE_PCTL: z.coerce.number().default(30),
  MAX_RANGE_PCTL: z.coerce.number().default(99),

  // Stop-loss quality gating
  MIN_SL_TICKS: z.coerce.number().default(2),
  MAX_SL_PCT: z.coerce.number().default(1.0),

  // Signal quality gating (reduces overtrading)
  // Skip signals below this confidence score (0-100). Set to 0 to disable.
  MIN_SIGNAL_CONFIDENCE: z.coerce.number().default(75),
  SIGNAL_PREEMIT_GLOBAL_MIN_NORMALIZED_CONFIDENCE: z.coerce.number().default(67),
  SIGNAL_PREEMIT_GLOBAL_MIN_QUALITY_SCORE: z.coerce.number().default(60),
  SIGNAL_PREEMIT_GLOBAL_MIN_CONTEXT_SCORE: z.coerce.number().default(58),
  SIGNAL_PREEMIT_GLOBAL_MIN_FINAL_SCORE: z.coerce.number().default(71),
  SIGNAL_PREEMIT_GLOBAL_MIN_MTF_SCORE: z.coerce.number().default(50),
  SIGNAL_PREEMIT_GLOBAL_MIN_FRESHNESS: z.coerce.number().default(58),

  // Cost/edge gating (prevents tiny targets that cannot beat costs)
  ENABLE_COST_GATE: z.string().default("true"),
  COST_GATE_MULT: z.coerce.number().default(3), // expected move must be >= 3x estimated all-in costs
  // Planned fee-multiple gate: (plannedProfit @ RR target) / estCosts. 0 disables.
  FEE_MULTIPLE_PLANNED_MIN: z.coerce.number().default(0),
  EXPECTED_MOVE_ATR_PERIOD: z.coerce.number().default(14),
  EXPECTED_MOVE_ATR_MULT: z.coerce.number().default(0.5),
  // Expected-move horizon: cost gate should match realistic holding time (5–15m)
  EXPECTED_MOVE_HORIZON_MIN: z.coerce.number().default(15),
  EXPECTED_MOVE_REF_INTERVALS: z.string().default("15,5,3,1"),
  EXPECTED_MOVE_SCALE_MODE: z.string().default("SQRT_TIME"), // SQRT_TIME | NONE
  // Approximate variable charges (STT+exch+SEBI+stamp+GST etc) as bps of turnover (buy+sell)
  COST_VARIABLE_BPS: z.coerce.number().default(6),
  COST_VARIABLE_BPS_OPT: z.coerce.number().optional(),
  COST_VARIABLE_BPS_FUT: z.coerce.number().optional(),
  COST_VARIABLE_BPS_EQ_DELIVERY: z.coerce.number().optional(),
  // Slippage estimate for market orders as bps of turnover (buy+sell)
  COST_SLIPPAGE_BPS: z.coerce.number().default(6),
  COST_SLIPPAGE_BPS_OPT: z.coerce.number().optional(),
  COST_SLIPPAGE_BPS_FUT: z.coerce.number().optional(),
  COST_SLIPPAGE_BPS_EQ_DELIVERY: z.coerce.number().optional(),
  INCLUDE_SPREAD_IN_COST: z.string().default("true"),
  INCLUDE_SPREAD_IN_COST_OPT: z.string().optional(),
  INCLUDE_SPREAD_IN_COST_FUT: z.string().optional(),
  INCLUDE_SPREAD_IN_COST_EQ_DELIVERY: z.string().optional(),
  // Brokerage model (Zerodha: min(cap, pct of order value))
  BROKERAGE_PCT: z.coerce.number().default(0.03),
  BROKERAGE_MAX_PER_ORDER: z.coerce.number().default(20),
  // Derivatives (FUT/OPT): flat brokerage per executed order (Zerodha: ₹20/order).
  BROKERAGE_FNO_PER_ORDER_INR: z.coerce.number().default(20),
  BROKERAGE_FNO_PER_ORDER_INR_OPT: z.coerce.number().optional(),
  BROKERAGE_FNO_PER_ORDER_INR_FUT: z.coerce.number().optional(),
  // Equity delivery: typically ₹0 at Zerodha; override if your plan differs.
  BROKERAGE_EQ_DELIVERY_PER_ORDER_INR: z.coerce.number().default(0),
  BROKERAGE_EQ_DELIVERY_PER_ORDER_INR_EQ_DELIVERY: z.coerce.number().optional(),
  EXPECTED_EXECUTED_ORDERS: z.coerce.number().default(2), // entry + one exit leg
  EXPECTED_EXECUTED_ORDERS_OPT: z.coerce.number().optional(),
  EXPECTED_EXECUTED_ORDERS_FUT: z.coerce.number().optional(),
  EXPECTED_EXECUTED_ORDERS_EQ_DELIVERY: z.coerce.number().optional(),

  // PATCH-6: Cost calibration (post-trade reconciliation adjusts estimator multiplier)
  COST_CALIBRATION_ENABLED: z.string().default("false"),
  COST_CALIBRATION_ALPHA: z.coerce.number().default(0.25),
  COST_CALIBRATION_MULT_MIN: z.coerce.number().default(0.6),
  COST_CALIBRATION_MULT_MAX: z.coerce.number().default(2.5),

  // Don't take trades where planned SL (risk) in ₹ is too small (costs will dominate)
  MIN_SL_INR: z.coerce.number().default(300),

  // Softening for small accounts: if risk ₹ is below MIN_SL_INR, only block when
  // risk ₹ is also below (MIN_SL_INR_COST_MULT * estimated round-trip cost).
  // Example: with MIN_SL_INR=300 and MIN_SL_INR_COST_MULT=1.5, a ₹250-risk trade
  // is allowed if estCost is <= ~₹166.
  MIN_SL_INR_COST_MULT: z.coerce.number().default(1.5),

  // Optional regime gate (copy pros: trend/open only)
  REGIME_GATE_ENABLED: z.string().default("false"),
  ALLOWED_REGIMES: z.string().default("OPEN,TREND"),

  // Optional entry order type (MARKET or LIMIT). LIMIT reduces slippage but may miss fills.
  ENTRY_ORDER_TYPE: z.string().default("MARKET"),
  // Options-specific entry type (pro: LIMIT)
  ENTRY_ORDER_TYPE_OPT: z.string().default("LIMIT"),
  ENTRY_LIMIT_TIMEOUT_MS: z.coerce.number().default(4000),
  ENTRY_LIMIT_FALLBACK_GRACE_MS: z.coerce.number().default(250),
  ENTRY_LIMIT_FALLBACK_CANCEL_WAIT_MS: z.coerce.number().default(400),
  // Safety: do NOT auto-convert LIMIT -> MARKET. If you accept slippage, set ENTRY_ORDER_TYPE_OPT=MARKET explicitly.
  ENTRY_LIMIT_FALLBACK_TO_MARKET: boolFromEnv.default(false),
  MAX_EXECUTION_AGE_MS: z.coerce.number().default(20000),
  MAX_LATENCY_GRACE_MS: z.coerce.number().default(5000),
  MAX_SIGNAL_LATENCY_GRACE_MS: z.coerce.number().default(5000),
  EXEC_SIGNAL_MAX_AGE_MS: z.coerce.number().default(5000),
  EXEC_MAX_PREMIUM_DRIFT_PCT: z.coerce.number().default(1.0),
  EXEC_MAX_SPREAD_BPS: z.coerce.number().default(45),
  EXEC_MAX_CHASE_STEPS: z.coerce.number().default(3),
  EXEC_MAX_ENTRY_DEVIATION_PCT: z.coerce.number().default(1.2),
  // Smart limit laddering (micro-improve fills without blind chasing)
  ENTRY_LADDER_ENABLED: boolFromEnv.default(true),
  ENTRY_LADDER_TICKS: z.coerce.number().default(2),
  ENTRY_LADDER_STEP_DELAY_MS: z.coerce.number().default(350),
  ENTRY_LADDER_MAX_CHASE_BPS: z.coerce.number().default(35),
  ENTRY_LADDER_STYLE_ENABLED: boolFromEnv.default(true),
  ENTRY_LADDER_USE_LIVE_QUOTE: boolFromEnv.default(true),
  ENTRY_LADDER_URGENCY_BREAKOUT_MULT: z.coerce.number().default(2.4),
  ENTRY_LADDER_URGENCY_OPEN_MULT: z.coerce.number().default(2.0),
  ENTRY_LADDER_URGENCY_TREND_MULT: z.coerce.number().default(1.6),
  ENTRY_LADDER_URGENCY_RANGE_MULT: z.coerce.number().default(0.9),
  ENTRY_PENDING_EDGE_REVALIDATE_ENABLED: boolFromEnv.default(true),
  ENTRY_PENDING_CANCEL_ON_EDGE_DECAY: boolFromEnv.default(true),
  ENTRY_PENDING_REVALIDATE_AFTER_MS: z.coerce.number().default(1500),
  ENTRY_PENDING_MAX_SPREAD_BPS: z.coerce.number().default(45),
  ENTRY_PENDING_MAX_ADVERSE_UL_BPS: z.coerce.number().default(12),
  ENTRY_PENDING_MAX_MS_BREAKOUT: z.coerce.number().default(7000),
  ENTRY_PENDING_MAX_MS_OPEN: z.coerce.number().default(9000),
  ENTRY_PENDING_MAX_MS_TREND: z.coerce.number().default(12000),
  ENTRY_PENDING_MAX_MS_RANGE: z.coerce.number().default(20000),
  ALLOW_ONE_LOT_RISK_BUFFER_PCT: z.coerce.number().default(25),
  ENABLE_SL_COMPRESSION_WHEN_BLOCKED: boolFromEnv.default(true),
  MAX_SL_COMPRESSION_PCT: z.coerce.number().default(20),
  FNO_FORCE_ONE_LOT_MAX_BREACH_PCT: z.coerce.number().default(8),
  FNO_FORCE_ONE_LOT_REQUIRE_TAG: boolFromEnv.default(true),

  // Optional simple caps (highly recommended)
  MAX_QTY: z.coerce.number().optional(),
  MAX_POSITION_VALUE_INR: z.coerce.number().optional(),

  // Dynamic exit management (trail SL / adjust target)
  DYNAMIC_EXITS_ENABLED: z.string().default("false"),
  DYNAMIC_EXIT_MIN_INTERVAL_MS: z.coerce.number().default(2000),
  DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: z.coerce.number().default(800),
  DYNAMIC_EXIT_MIN_HOLD_MS: z.coerce.number().default(15000),
  DYNAMIC_EXIT_EARLY_TIGHTEN_MIN_R: z.coerce.number().default(0.6),
  DYNAMIC_EXIT_REQUIRE_SAFE_EXECUTION: z.string().default("true"),
  DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION:
    boolFromEnv.default(false),
  DYNAMIC_EXIT_MIN_EXECUTABLE_DISTANCE_TICKS: z.coerce.number().default(2),
  DYNAMIC_EXIT_MAX_EXECUTABLE_SPREAD_BPS: z.coerce.number().default(120),
  DYNAMIC_EXIT_DISABLE_ON_FAIL: z.string().default("false"),
  DYNAMIC_EXIT_CANCEL_REPLACE_ON_FAIL: z.string().default("true"),
  DYNAMIC_EXIT_SHADOW_MODE_ON_FAIL: z.string().default("true"),
  DYNAMIC_EXIT_PANIC_ON_SHADOW_BREACH: z.string().default("true"),
  EARLY_FAIL_ENABLED: z.string().default("true"),
  EARLY_FAIL_WINDOW_MS: z.coerce.number().default(90000),
  EARLY_FAIL_MIN_PEAK_R: z.coerce.number().default(0.25),
  EARLY_FAIL_MAX_STALL_MS: z.coerce.number().default(45000),
  EARLY_FAIL_STRUCTURE_BREAK_ENABLED: z.string().default("true"),
  // Early stall calibration: require time, bars, weakness, and confirmation before panic-exit.
  EARLY_STALL_MIN_TRADE_AGE_MS: z.coerce.number().default(20000),
  EARLY_STALL_MIN_BARS_SINCE_ENTRY: z.coerce.number().default(1),
  EARLY_STALL_CONFIRM_TICKS: z.coerce.number().default(3),
  EARLY_STALL_CONFIRM_MS: z.coerce.number().default(10000),
  EARLY_STALL_MIN_MFE_R: z.coerce.number().default(0.20),
  EARLY_STALL_MAX_ADVERSE_R: z.coerce.number().default(-0.08),
  EARLY_STALL_BREAKOUT_GRACE_MS: z.coerce.number().default(15000),
  EARLY_STALL_ORB_GRACE_MS: z.coerce.number().default(20000),
  // Early structure failure calibration: prefer underlying structure when available and
  // require a meaningful, confirmed breach before loss-containment panic-exit.
  EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: z.coerce.number().default(2),
  EARLY_STRUCTURE_FAIL_CONFIRM_MS: z.coerce.number().default(4000),
  EARLY_STRUCTURE_FAIL_BUFFER_POINTS: z.coerce.number().default(0),
  EARLY_STRUCTURE_FAIL_BUFFER_TICKS: z.coerce.number().default(6),
  EARLY_STRUCTURE_FAIL_BUFFER_ATR_FRACTION: z.coerce.number().default(0.15),
  EARLY_STRUCTURE_FAIL_USE_UNDERLYING: boolFromEnv.default(true),
  EARLY_FAIL_LOG_VERBOSE: boolFromEnv.default(true),
  POST_FILL_RISK_SOFT_BREACH_PCT: z.coerce.number().default(5),
  POST_FILL_RISK_HARD_BREACH_PCT: z.coerce.number().default(12),
  POST_FILL_RISK_SOFT_ACTION: z.string().default("TAG_ONLY"),
  POST_FILL_RISK_HARD_ACTION: z.string().default("EXIT"),
  POST_FILL_RISK_REDUCE_IF_POSSIBLE: boolFromEnv.default(true),

  // Executable vs idea signal split (keep logging ideas, route only executable)
  EXECUTABLE_SIGNAL_GATE_ENABLED: boolFromEnv.default(true),

  // Market-condition circuit breakers (rolling 5m window)
  CIRCUIT_BREAKERS_ENABLED: boolFromEnv.default(true),
  CB_MAX_REJECTS_5M: z.coerce.number().default(5),
  CB_MAX_SPREAD_SPIKES_5M: z.coerce.number().default(8),
  CB_MAX_STALE_TICKS_5M: z.coerce.number().default(12),
  CB_MAX_QUOTE_GUARD_HITS_5M: z.coerce.number().default(4),
  CB_COOLDOWN_SEC: z.coerce.number().default(180),
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: z.coerce.number().default(5),

  DYN_ATR_PERIOD: z.coerce.number().default(14),
  DYN_TRAIL_ATR_MULT: z.coerce.number().default(1.2),
  DYN_MOVE_SL_TO_BE_AT_R: z.coerce.number().default(0.8),
  // "True breakeven" = entry +/- estimated per-share cost * mult (avoid fee-negative BE exits)
  DYN_BE_COST_MULT: z.coerce.number().default(1.0),
  DYN_BE_BUFFER_TICKS: z.coerce.number().default(1),

  // Start ATR trailing only after trade is meaningfully in profit (reduces noise stopouts)
  DYN_TRAIL_START_R: z.coerce.number().default(1.0),

  DYN_TRAIL_STEP_TICKS: z.coerce.number().default(20),
  DYN_STEP_TICKS_PRE_BE: z.coerce.number().default(10),
  DYN_STEP_TICKS_POST_BE: z.coerce.number().default(5),
  DYN_TRAIL_START_PROFIT_INR: z.coerce.number().default(0),
  OPTION_TRAIL_USE_UNDERLYING_CONFIRM: z.string().default("true"),
  OPTION_TRAIL_REQUIRE_EXECUTABLE_MFE: z.string().default("true"),
  OPTION_EXECUTABLE_PRICE_MODE: z.string().default("BID_SIDE"),
  OPTION_PREMIUM_TRAIL_WEIGHT: z.coerce.number().default(0.35),
  OPTION_UNDERLYING_TRAIL_WEIGHT: z.coerce.number().default(0.65),

  // STATIC | FOLLOW_RR | TIGHTEN_VWAP
  DYN_TARGET_MODE: z.string().default("STATIC"),
  DYN_TARGET_RR: z.coerce.number().optional(),
  DYN_VWAP_LOOKBACK: z.coerce.number().default(120),
  DYN_TARGET_TIGHTEN_FRAC: z.coerce.number().default(0.6),

  // Pro safety: avoid shrinking targets early (kills avg winner vs fees)
  DYN_ALLOW_TARGET_TIGHTEN: z.string().default("false"),
  DYN_TARGET_TIGHTEN_AFTER_R: z.coerce.number().default(1.5),

  // Pro mode: scale-out (TP1 + Runner)
  SCALE_OUT_ENABLED: z.string().default("false"),
  TP1_QTY_PCT: z.coerce.number().default(50), // % of position to book at TP1
  TP1_R: z.coerce.number().default(1.0), // TP1 distance in R (risk units)

  // Runner target planning
  RUNNER_TARGET_PRIORITY: z.string().default("PIVOT,SWING,ATR,RR"),
  RUNNER_MIN_RR: z.coerce.number().default(1.5),
  RUNNER_FALLBACK_RR: z.coerce.number().default(2.0),
  RUNNER_ATR_MULT: z.coerce.number().default(2.0),
  RUNNER_SWING_LOOKBACK: z.coerce.number().default(120),
  RUNNER_VWAP_LOOKBACK: z.coerce.number().default(120),
  RUNNER_BE_BUFFER_TICKS: z.coerce.number().default(1),
  RUNNER_KEEP_TP2_RESTING: z.string().default("true"),

  // If true, dynamic exit adjustments start only after TP1 is done (recommended with scale-out).
  DYNAMIC_EXITS_AFTER_TP1_ONLY: z.string().default("false"),

  // =========================
  // Dynamic pacing policy (aim trades/day without hard-coded gates)
  // =========================
  PACE_POLICY_ENABLED: z.string().default("true"),
  PACE_TARGET_TRADES_PER_DAY: z.coerce.number().default(6),
  PACE_MIN_CONF_FLOOR: z.coerce.number().default(62),
  PACE_MAX_CONF_CEIL: z.coerce.number().default(85),
  PACE_CONF_STEP: z.coerce.number().default(3),
  PACE_MIN_SPREAD_FLOOR_BPS: z.coerce.number().default(14),
  PACE_MAX_SPREAD_CEIL_BPS: z.coerce.number().default(22),
  PACE_SPREAD_STEP_BPS: z.coerce.number().default(2),
  PACE_MIN_REL_VOL_FLOOR: z.coerce.number().default(0.45),
  PACE_MAX_REL_VOL_CEIL: z.coerce.number().default(1.2),
  PACE_REL_VOL_STEP: z.coerce.number().default(0.05),

  // =========================
  // Plan builder (dynamic SL/Target from structure + ATR)
  // =========================
  PLAN_ENABLED: z.string().default("true"),
  PLAN_CANDLE_LIMIT: z.coerce.number().default(800),
  PLAN_SWING_LOOKBACK: z.coerce.number().default(60),
  PLAN_RANGE_LOOKBACK: z.coerce.number().default(30),
  PLAN_SL_ATR_K_TREND: z.coerce.number().default(0.8),
  PLAN_SL_ATR_K_RANGE: z.coerce.number().default(0.6),
  PLAN_SL_ATR_K_OPEN: z.coerce.number().default(1.0),
  PLAN_SL_ATR_K_DEFAULT: z.coerce.number().default(0.8),
  PLAN_TARGET_ATR_M_TREND: z.coerce.number().default(1.4),
  PLAN_TARGET_ATR_M_RANGE: z.coerce.number().default(0.9),
  PLAN_TARGET_ATR_M_OPEN: z.coerce.number().default(1.2),
  PLAN_TARGET_ATR_M_DEFAULT: z.coerce.number().default(1.2),
  PLAN_SL_NOISE_ATR_MIN_MULT: z.coerce.number().default(0.25),
  PLAN_TARGET_EXPECTED_MOVE_MULT: z.coerce.number().default(1.3),

  // Min RR by style (pro defaults)
  STYLE_MIN_RR_TREND: z.coerce.number().default(1.6),
  STYLE_MIN_RR_RANGE: z.coerce.number().default(1.3),
  STYLE_MIN_RR_OPEN: z.coerce.number().default(1.4),
  STYLE_MIN_RR_DEFAULT: z.coerce.number().default(1.4),

  // OPEN bucket sizing
  OPEN_RISK_MULT: z.coerce.number().default(0.7),

  // =========================
  // Options: underlying-based mapping helpers
  // =========================
  OPT_DELTA_ATM: z.coerce.number().default(0.5),
  OPT_DELTA_ITM: z.coerce.number().default(0.65),
  OPT_DELTA_OTM: z.coerce.number().default(0.4),
  OPT_GAMMA_SCALE_MAX: z.coerce.number().default(1.25),
  OPT_VOL_REF_ATR_PCT: z.coerce.number().default(0.6),
});

const env = schema.parse(process.env);

// Back-compat mapping: allow older OPT_* env keys to drive the new canonical keys.
// We check raw process.env presence so defaults don't accidentally override.
function hasRawEnv(k) {
  return (
    Object.prototype.hasOwnProperty.call(process.env, k) &&
    process.env[k] !== undefined &&
    String(process.env[k]).trim() !== ""
  );
}
if (!hasRawEnv("OPT_STRIKE_OFFSET_STEPS") && hasRawEnv("OPT_STRIKE_OFFSET")) {
  env.OPT_STRIKE_OFFSET_STEPS = Number(env.OPT_STRIKE_OFFSET);
}
if (!hasRawEnv("OPT_ATM_SCAN_STEPS") && hasRawEnv("OPT_STRIKE_SCAN_STEPS")) {
  env.OPT_ATM_SCAN_STEPS = Number(env.OPT_STRIKE_SCAN_STEPS);
}

const PROFILE_PRESETS = {
  // Conservative first-live profile: later BE/trailing, wider post-BE gap, slower modify cadence.
  LIVE_CONSERVATIVE: {
    BE_ARM_R: 0.8,
    TRAIL_ARM_R: 1.35,
    TRAIL_GAP_POST_BE_PCT: 0.06,
    TRAIL_GAP_POST_BE_PCT_TIGHT: 0.05,
    TRAIL_TIGHTEN_R: 2.2,
    EXIT_TIGHTEN_AT_R: 2.0,
    DYN_STEP_TICKS_POST_BE: 8,
    DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 1500,
    EXIT_TIGHTEN_WEAK_REGIME_GOVERNOR_ENABLED: true,
    EXIT_TIGHTEN_WEAK_REGIMES: "RANGE,CHOP,WEAK",
  },
  NIFTY_OPT_SCALP_SAFE: {
    STOPLOSS_ORDER_TYPE_FO: "SL",
    SL_LIMIT_BUFFER_BPS: 50,
    SL_LIMIT_BUFFER_TICKS: 10,
    PANIC_EXIT_LIMIT_FALLBACK_ENABLED: "true",
    ENTRY_SLIPPAGE_GUARD_FOR_LIMIT: "true",
    MAX_ENTRY_SLIPPAGE_BPS_OPT: 120,
    MAX_ENTRY_SLIPPAGE_KILL_BPS_OPT: 250,
    OPT_TP_ENABLED: "false",
    TIME_STOP_MIN: 5,
  },
};

const presetKey = String(
  env.PROFILE_PRESET ||
    (env.LIVE_CONSERVATIVE_PROFILE ? "LIVE_CONSERVATIVE" : ""),
)
  .trim()
  .toUpperCase();
if (presetKey && PROFILE_PRESETS[presetKey]) {
  const preset = PROFILE_PRESETS[presetKey];
  for (const [key, value] of Object.entries(preset)) {
    if (!hasRawEnv(key)) {
      env[key] = value;
    }
  }
}

function failOrWarn(msg) {
  if (String(env.NODE_ENV || "development") === "production") {
    throw new Error(msg);
  }
  // eslint-disable-next-line no-console
  console.warn(msg);
}

function validateProfileCombos() {
  if (String(env.PROFILE_VALIDATE || "true") !== "true") return;

  const fnoEnabled = String(env.FNO_ENABLED || "false") === "true";
  const stopTypeFo = String(env.STOPLOSS_ORDER_TYPE_FO || "")
    .toUpperCase()
    .trim();

  // SL-M handling (F&O):
  // - Many brokers (including Zerodha) allow SL-M for options, but rejections can still happen.
  // - Our TradeManager already has SL-M -> SL fallback with buffers.
  // - Therefore: allow SL-M in OPT mode (warn only), and keep the conservative auto-fix for non-OPT modes.
  if (fnoEnabled && stopTypeFo === "SL-M") {
    const fnoMode = String(env.FNO_MODE || "")
      .toUpperCase()
      .trim();
    if (fnoMode && fnoMode !== "OPT") {
      env.STOPLOSS_ORDER_TYPE_FO = "SL";
      // eslint-disable-next-line no-console
      console.warn(
        "[config] Unsafe combo auto-fixed: STOPLOSS_ORDER_TYPE_FO=SL-M -> SL for non-OPT F&O safety.",
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[config] Note: STOPLOSS_ORDER_TYPE_FO=SL-M in OPT mode; engine will try SL-M then fallback to SL (buffer) if rejected.",
      );
    }
  }

  const forceLot =
    String(env.FNO_MIN_LOT_POLICY || "STRICT").toUpperCase() ===
    "FORCE_ONE_LOT";
  const riskInr = Number(env.RISK_PER_TRADE_INR ?? 0);
  if (fnoEnabled && forceLot && Number.isFinite(riskInr) && riskInr < 100) {
    failOrWarn(
      "[config] Unsafe combo: FORCE_ONE_LOT with very low RISK_PER_TRADE_INR may block trades or force oversized risk.",
    );
  }

  const optTpEnabled = String(env.OPT_TP_ENABLED || "false") === "true";
  const timeStopMin = Number(env.TIME_STOP_MIN ?? 0);
  const noProgressMin = Number(env.TIME_STOP_NO_PROGRESS_MIN ?? 0);
  const maxHoldMin = Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0);
  const proTimeStopsEnabled =
    (Number.isFinite(noProgressMin) && noProgressMin > 0) ||
    (Number.isFinite(maxHoldMin) && maxHoldMin > 0);
  if (!optTpEnabled && (!Number.isFinite(timeStopMin) || timeStopMin <= 0)) {
    if (!proTimeStopsEnabled) {
      failOrWarn(
        "[config] Unsafe combo: OPT_TP_ENABLED=false requires TIME_STOP_MIN>0 or pro time-stops (TIME_STOP_NO_PROGRESS_MIN/TIME_STOP_MAX_HOLD_MIN) to avoid lingering positions.",
      );
    }
  }

  const dtePreferMin = Number(env.OPT_DTE_PREFER_MIN ?? 1);
  const dtePreferMax = Number(env.OPT_DTE_PREFER_MAX ?? 3);
  const dteFallbackMax = Number(env.OPT_DTE_FALLBACK_MAX ?? 7);
  if (!Number.isFinite(dtePreferMin) || dtePreferMin < 0) {
    failOrWarn("[config] OPT_DTE_PREFER_MIN must be >= 0");
  }
  if (!Number.isFinite(dtePreferMax) || dtePreferMax < dtePreferMin) {
    failOrWarn("[config] OPT_DTE_PREFER_MAX must be >= OPT_DTE_PREFER_MIN");
  }
  if (!Number.isFinite(dteFallbackMax) || dteFallbackMax < dtePreferMax) {
    failOrWarn("[config] OPT_DTE_FALLBACK_MAX must be >= OPT_DTE_PREFER_MAX");
  }

  const premiumMin = Number(env.OPT_MIN_PREMIUM ?? 0);
  const premiumMax = Number(env.OPT_MAX_PREMIUM ?? 0);
  if (
    Number.isFinite(premiumMin) &&
    Number.isFinite(premiumMax) &&
    premiumMin > premiumMax
  ) {
    failOrWarn("[config] OPT_MIN_PREMIUM must be <= OPT_MAX_PREMIUM");
  }

  const deltaMin = Number(env.OPT_DELTA_BAND_MIN ?? 0);
  const deltaMax = Number(env.OPT_DELTA_BAND_MAX ?? 1);
  if (deltaMin < 0 || deltaMax > 1 || deltaMin >= deltaMax) {
    failOrWarn(
      "[config] Delta band invalid. Expected 0 <= OPT_DELTA_BAND_MIN < OPT_DELTA_BAND_MAX <= 1",
    );
  }
}

validateProfileCombos();

(function logConfigFingerprint() {
  const crypto = require("crypto");
  const safeConfig = {
    tz: env.CANDLE_TZ,
    liveConservativeProfile: env.LIVE_CONSERVATIVE_PROFILE,
    fnoMode: env.FNO_MODE,
    optExpiryPolicy: env.OPT_EXPIRY_POLICY,
    optAllowZeroDte: env.OPT_ALLOW_ZERO_DTE,
    optDtePreferMin: env.OPT_DTE_PREFER_MIN,
    optDtePreferMax: env.OPT_DTE_PREFER_MAX,
    optDteFallbackMax: env.OPT_DTE_FALLBACK_MAX,
    premiumMin: env.OPT_MIN_PREMIUM,
    premiumMax: env.OPT_MAX_PREMIUM,
    deltaBandMin: env.OPT_DELTA_BAND_MIN,
    deltaBandMax: env.OPT_DELTA_BAND_MAX,
    minSignalConfidence: env.MIN_SIGNAL_CONFIDENCE,
    signalStatePersist: env.SIGNAL_STATE_PERSIST,
    signalPreEmitMinNormalized: env.SIGNAL_PREEMIT_GLOBAL_MIN_NORMALIZED_CONFIDENCE,
    signalPreEmitMinQuality: env.SIGNAL_PREEMIT_GLOBAL_MIN_QUALITY_SCORE,
    signalPreEmitMinContext: env.SIGNAL_PREEMIT_GLOBAL_MIN_CONTEXT_SCORE,
    signalPreEmitMinFinal: env.SIGNAL_PREEMIT_GLOBAL_MIN_FINAL_SCORE,
    riskPerTradeInr: env.RISK_PER_TRADE_INR,
    beArmR: env.BE_ARM_R,
    trailArmR: env.TRAIL_ARM_R,
    trailGapPostBePct: env.TRAIL_GAP_POST_BE_PCT,
    trailTightenR: env.TRAIL_TIGHTEN_R,
    exitTightenAtR: env.EXIT_TIGHTEN_AT_R,
    dynStepTicksPostBe: env.DYN_STEP_TICKS_POST_BE,
    dynExitMinModifyIntervalMs: env.DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS,
    stopTypeFo: env.STOPLOSS_ORDER_TYPE_FO,
    slBufferBps: env.SL_LIMIT_BUFFER_BPS,
    slSlaMs: env.SL_SAFETY_SLA_MS,
  };
  const payload = JSON.stringify(safeConfig);
  const fp = crypto
    .createHash("sha1")
    .update(payload)
    .digest("hex")
    .slice(0, 12);
  // eslint-disable-next-line no-console
  console.info(`[config] fingerprint=${fp} ${payload}`);
})();

// --- Trading window validation (PROD SAFETY) ---
// We must NEVER trade with an invalid window configuration.
// If STOP_NEW_ENTRIES_AFTER >= FORCE_FLATTEN_AT:
//  - In development: you may set AUTO_FIX_TIME_WINDOWS=true to auto-fix safely.
//  - In production: default is strict (crash early) so you don't run unsafe.
function parseHHmm(value, name) {
  const s = String(value || "").trim();
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m)
    throw new Error(
      `[config] Invalid time format for ${name}: "${s}" (expected HH:mm)`,
    );
  return Number(m[1]) * 60 + Number(m[2]);
}

function toHHmm(totalMin) {
  const mm = Math.max(0, Math.min(23 * 60 + 59, Math.floor(totalMin)));
  const h = String(Math.floor(mm / 60)).padStart(2, "0");
  const m = String(mm % 60).padStart(2, "0");
  return `${h}:${m}`;
}

(function validateTradingWindows() {
  const stopEntryMin = parseHHmm(
    env.STOP_NEW_ENTRIES_AFTER,
    "STOP_NEW_ENTRIES_AFTER",
  );
  const flattenMin = parseHHmm(env.FORCE_FLATTEN_AT, "FORCE_FLATTEN_AT");

  if (stopEntryMin >= flattenMin) {
    const autoFix = String(env.AUTO_FIX_TIME_WINDOWS || "false") === "true";
    const fixed = toHHmm(flattenMin - 15);

    const msg =
      `[config] Invalid time windows: STOP_NEW_ENTRIES_AFTER (${env.STOP_NEW_ENTRIES_AFTER}) ` +
      `must be earlier than FORCE_FLATTEN_AT (${env.FORCE_FLATTEN_AT}).`;

    if (autoFix) {
      // eslint-disable-next-line no-console
      console.warn(`${msg} Auto-fixing STOP_NEW_ENTRIES_AFTER to ${fixed}.`);
      env.STOP_NEW_ENTRIES_AFTER = fixed;
    } else {
      // Fail-fast: never start trading with unsafe windows.
      throw new Error(
        `${msg} Fix your .env (recommended: STOP_NEW_ENTRIES_AFTER=15:00, FORCE_FLATTEN_AT=15:20)`,
      );
    }
  }

  const convertEnabled = env.EOD_MIS_TO_NRML_ENABLED !== false;
  if (convertEnabled) {
    const convertMin = parseHHmm(env.EOD_MIS_TO_NRML_AT, "EOD_MIS_TO_NRML_AT");
    if (convertMin >= flattenMin) {
      const eodTimeProvided = process.env.EOD_MIS_TO_NRML_AT != null;
      if (!eodTimeProvided) {
        const fixed = toHHmm(flattenMin - 2);
        // eslint-disable-next-line no-console
        console.warn(
          `[config] EOD_MIS_TO_NRML_AT default (${env.EOD_MIS_TO_NRML_AT}) is not earlier than FORCE_FLATTEN_AT (${env.FORCE_FLATTEN_AT}). ` +
            `Auto-fixing EOD_MIS_TO_NRML_AT to ${fixed}. Set EOD_MIS_TO_NRML_AT explicitly to override.`,
        );
        env.EOD_MIS_TO_NRML_AT = fixed;
      } else {
        throw new Error(
          `[config] EOD_MIS_TO_NRML_AT (${env.EOD_MIS_TO_NRML_AT}) must be earlier than FORCE_FLATTEN_AT (${env.FORCE_FLATTEN_AT}).`,
        );
      }
    }
  }
})();

const subscribeTokens = Array.from(
  new Set(
    String(process.env.SUBSCRIBE_TOKENS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  ),
);

const subscribeSymbols = Array.from(
  new Set(
    String(process.env.SUBSCRIBE_SYMBOLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
);

module.exports = { env, subscribeTokens, subscribeSymbols };
