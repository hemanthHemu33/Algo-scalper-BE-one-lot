# Pro Risk / Exit Refactor

- **SL is strategy-defined; sizing is risk-defined**: when plan SL is marked `STRATEGY`, trade sizing/contract-picking must adapt and SL is not tightened to fit caps.
- **Options fallback policy**: when 1-lot risk does not fit, high-confidence entries may choose lower-premium contracts first; only last-resort bounded one-lot overbudget is allowed.
- **Exit and daily governor are R-first**: min-green/BE/trail arming is based on price-R, and daily stop/profit governors are enforced in R terms (INR hard caps are deprecated defaults).
